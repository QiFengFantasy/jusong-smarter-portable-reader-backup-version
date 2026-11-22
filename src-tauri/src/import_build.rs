//! 导入构建（Import Build）写入：AGENT 生成的地图地点/时间线事件与章节探索投影。
//!
//! 这是「EPUB 基础导入 → 选择构建条目 → AGENT 团队构建」流程的落盘入口：
//! - `shared/topics/map.json`（themes/places/routes.features）按 id 合并；
//! - `shared/topics/timeline.json`（events 按 id 合并，config.enabledArticleIds 并集）；
//! - 每章 `chapters/<id>/explore.json`（placeIds/routeIds/themeIds/eventIds 并集，
//!   focus 保留已有值，没有时用本次值）。
//!
//! 设计约定：
//! - 只写派生数据，不改 `book.json`；place/timeline 知识条目仍走 `library_add_knowledge`。
//! - 合并时保留已有条目（按 id 去重，旧条目字段不被新值覆盖），重复调用幂等：
//!   内容无变化时不重写文件（保留原 `generatedAt` 字节）。
//! - 先全量校验参数再写盘；每个文件复用 `library::write_json`（tmp → rename 原子替换）。
//! - 写路径共享 `library::write_guard` 串行锁，避免与导入/摘要回写并发写同一本书。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::library::{data_dir, debug_log, read_json_opt, run, write_guard, write_json, ApiError};
use crate::util::{load_valid_book, now_rfc3339, valid_chapter_id};

/// topics / explore 文件的数据版本（与种子数据、前端 `ChapterExplore` 类型一致）。
const TOPICS_SCHEMA_VERSION: u64 = 1;
/// 一次 IPC 允许的章节探索条目上限（防误传超长数组）。
const MAX_EXPLORE_CHAPTERS: usize = 1_000;
/// 合并后单个 topics 数组（places/events/features 等）的条目上限。
const MAX_TOPIC_ENTRIES: usize = 5_000;
/// topics/explore 里 id 的最大字符数（短 slug，与读取侧宽松口径一致）。
const ID_MAX_CHARS: usize = 200;

/// AGENT 构建产出的单章探索写入（`AgentExploreWrite` 的 Rust 侧形态）。
#[derive(Default)]
struct ExploreInput {
    chapter_id: String,
    map: Option<ExploreMapInput>,
    timeline: Option<Vec<String>>,
}

#[derive(Default)]
struct ExploreMapInput {
    place_ids: Vec<String>,
    route_ids: Vec<String>,
    theme_ids: Vec<String>,
    focus: Option<Value>,
}

/// 合并 AGENT 构建产出的地图/时间线专题与章节探索投影（原子写，幂等）。
///
/// 参数与 `@jusong/core` 的 `Library.applyAgentKnowledge` 对齐：
/// `bookId, map?, timeline?, explores`；`map`/`timeline` 为整书专题 JSON（可为 null）。
/// 返回 `{ places, events, explores }`：本次新增的地点数、事件数、写入的探索章节数。
#[tauri::command]
pub async fn library_apply_agent_knowledge(
    app: AppHandle,
    book_id: String,
    map: Option<Value>,
    timeline: Option<Value>,
    explores: Option<Vec<Value>>,
) -> Result<Value, ApiError> {
    debug_log("apply_agent_knowledge");
    run(move || {
        let books_root = data_dir(&app)?.join("books");
        apply_agent_knowledge_into(
            &books_root,
            &book_id,
            map.as_ref(),
            timeline.as_ref(),
            explores.as_deref().unwrap_or(&[]),
        )
    })
    .await
}

/// 合并实现（不依赖 Tauri runtime，便于单元测试）。
///
/// 顺序：校验书 + 章节归属 → 校验全部入参 → 写 topics → 写 explore。
/// 任一校验失败都不会产生任何写盘。
pub(crate) fn apply_agent_knowledge_into(
    books_root: &Path,
    book_id: &str,
    map: Option<&Value>,
    timeline: Option<&Value>,
    explores: &[Value],
) -> Result<Value, ApiError> {
    // 1) 书必须存在（与 library_get_book 同口径；pending 原始文件书也认可）。
    let book = load_valid_book(books_root, book_id, true).ok_or_else(|| {
        ApiError::new(
            "NOT_FOUND",
            format!("书籍不存在或不是当前数据格式：{book_id}"),
        )
    })?;
    let chapter_ids: Vec<String> = book
        .get("chapterIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 2) 先全量校验，避免写到一半才发现非法输入（写盘阶段不再报参数错误）。
    let map_input = optional_object(map, "map")?;
    let timeline_input = optional_object(timeline, "timeline")?;
    if explores.len() > MAX_EXPLORE_CHAPTERS {
        return Err(ApiError::invalid(format!(
            "explores 数量超过上限（{MAX_EXPLORE_CHAPTERS}）"
        )));
    }
    let mut validated: Vec<ExploreInput> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for value in explores {
        let input = validate_explore(value, &chapter_ids)?;
        match positions.get(&input.chapter_id) {
            // 同一章在本次 payload 内重复出现：合并成一条（数组并集，focus 先到先得）。
            Some(index) => merge_explore_input(&mut validated[*index], input),
            None => {
                positions.insert(input.chapter_id.clone(), validated.len());
                validated.push(input);
            }
        }
    }

    // 3) 串行写盘：topics 事实源 + 章节探索投影；write_json 内部 tmp → rename。
    let _guard = write_guard()?;
    let places = match map_input {
        Some(map_input) => merge_map_topics(books_root, book_id, map_input)?,
        None => 0,
    };
    let events = match timeline_input {
        Some(timeline_input) => merge_timeline_topics(books_root, book_id, timeline_input)?,
        None => 0,
    };
    for input in &validated {
        merge_chapter_explore(books_root, book_id, input)?;
    }

    Ok(json!({
        "places": places,
        "events": events,
        "explores": validated.len(),
    }))
}

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

/// `map`/`timeline` 顶层：缺省或 JSON null 表示不写；其余必须是 JSON 对象。
fn optional_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> Result<Option<&'a Map<String, Value>>, ApiError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => Ok(Some(object)),
        Some(_) => Err(ApiError::invalid(format!(
            "{label} 必须是 JSON 对象或 null"
        ))),
    }
}

/// 校验单章探索写入：每项必须是对象、chapterId 属于本书、map/timeline/数组类型严格。
fn validate_explore(value: &Value, chapter_ids: &[String]) -> Result<ExploreInput, ApiError> {
    let Some(object) = value.as_object() else {
        return Err(ApiError::invalid("explores 每项必须是 JSON 对象"));
    };
    let chapter_id = object
        .get("chapterId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ApiError::invalid("explores 每项缺少 chapterId"))?;
    if !valid_chapter_id(chapter_id) {
        return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
    }
    if !chapter_ids.iter().any(|id| id == chapter_id) {
        return Err(ApiError::invalid(format!("章节不属于本书：{chapter_id}")));
    }
    let map = match object.get("map") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(ExploreMapInput {
            place_ids: ids_from_array(map.get("placeIds"), "explores.map.placeIds")?,
            route_ids: ids_from_array(map.get("routeIds"), "explores.map.routeIds")?,
            theme_ids: ids_from_array(map.get("themeIds"), "explores.map.themeIds")?,
            focus: match map.get("focus") {
                None | Some(Value::Null) => None,
                Some(value) => Some(focus_value(value).ok_or_else(|| {
                    ApiError::invalid("explores.map.focus 非法（需有限 lon/lat，经纬度在合法范围）")
                })?),
            },
        }),
        Some(_) => {
            return Err(ApiError::invalid(format!(
                "explores.map 必须是对象或 null：{chapter_id}"
            )))
        }
    };
    let timeline = match object.get("timeline") {
        None | Some(Value::Null) => None,
        Some(Value::Object(timeline)) => Some(ids_from_array(
            timeline.get("eventIds"),
            "explores.timeline.eventIds",
        )?),
        Some(_) => {
            return Err(ApiError::invalid(format!(
                "explores.timeline 必须是对象或 null：{chapter_id}"
            )))
        }
    };
    Ok(ExploreInput {
        chapter_id: chapter_id.to_string(),
        map,
        timeline,
    })
}

/// 严格读取 id 数组：字段缺省视为空；出现则必须是字符串数组，元素 1–200 字符。
fn ids_from_array(value: Option<&Value>, label: &str) -> Result<Vec<String>, ApiError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| ApiError::invalid(format!("{label} 必须是字符串数组")))?;
    if items.len() > MAX_TOPIC_ENTRIES {
        return Err(ApiError::invalid(format!(
            "{label} 条目数超过上限（{MAX_TOPIC_ENTRIES}）"
        )));
    }
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.chars().count() <= ID_MAX_CHARS)
            .ok_or_else(|| {
                ApiError::invalid(format!(
                    "{label} 含非法条目（需 1–{ID_MAX_CHARS} 字符字符串）"
                ))
            })?;
        ids.push(id.to_string());
    }
    Ok(ids)
}

/// 规范化 focus：lon/lat 必须有限且在合法范围；zoom 可选、非法时丢弃。
/// 返回 None 表示不是合法 focus 对象（入参校验据此拒绝）。
fn focus_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let lon = object.get("lon").and_then(Value::as_f64)?;
    let lat = object.get("lat").and_then(Value::as_f64)?;
    if !lon.is_finite()
        || !lat.is_finite()
        || !(-180.0..=180.0).contains(&lon)
        || !(-90.0..=90.0).contains(&lat)
    {
        return None;
    }
    let mut focus = json!({ "lon": lon, "lat": lat });
    if let Some(zoom) = object
        .get("zoom")
        .and_then(Value::as_f64)
        .filter(|zoom| zoom.is_finite() && *zoom >= 0.0)
    {
        focus["zoom"] = json!(zoom);
    }
    Some(focus)
}

/// 同一章重复写入时合并：id 数组取并集，focus 先到先得。
fn merge_explore_input(target: &mut ExploreInput, extra: ExploreInput) {
    if let Some(extra_map) = extra.map {
        match &mut target.map {
            None => target.map = Some(extra_map),
            Some(map) => {
                map.place_ids = union_strings(&map.place_ids, &extra_map.place_ids);
                map.route_ids = union_strings(&map.route_ids, &extra_map.route_ids);
                map.theme_ids = union_strings(&map.theme_ids, &extra_map.theme_ids);
                if map.focus.is_none() {
                    map.focus = extra_map.focus;
                }
            }
        }
    }
    if let Some(extra_events) = extra.timeline {
        match &mut target.timeline {
            None => target.timeline = Some(extra_events),
            Some(events) => *events = union_strings(events, &extra_events),
        }
    }
}

fn union_strings(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut ids = Vec::with_capacity(existing.len() + incoming.len());
    for id in existing.iter().chain(incoming.iter()) {
        if seen.insert(id.clone()) {
            ids.push(id.clone());
        }
    }
    ids
}

// ---------------------------------------------------------------------------
// topics 合并（map.json / timeline.json）
// ---------------------------------------------------------------------------

/// 合并 `shared/topics/map.json`：themes/places/routes.features 按 id 去重追加。
/// 返回本次新增的 place 条目数（themes/features 只写不计数）。
fn merge_map_topics(
    books_root: &Path,
    book_id: &str,
    incoming: &Map<String, Value>,
) -> Result<usize, ApiError> {
    let path = books_root
        .join(book_id)
        .join("shared")
        .join("topics")
        .join("map.json");
    let existing = read_json_opt(&path)?;
    let mut base = match &existing {
        Some(Value::Object(object)) => object.clone(),
        Some(_) => {
            return Err(ApiError::new(
                "CORRUPTED",
                "shared/topics/map.json 顶层不是 JSON 对象",
            ))
        }
        None => new_map_object(book_id),
    };
    // 数据归属以调用参数为准（文件里的旧 bookId/schemaVersion 不采信）。
    base.insert("schemaVersion".to_string(), json!(TOPICS_SCHEMA_VERSION));
    base.insert("bookId".to_string(), json!(book_id));

    let mut places_added = 0usize;
    for key in ["themes", "places"] {
        let mut merged = take_topic_array(&mut base, key, "map.json")?;
        let extra = incoming_topic_array(incoming, key, "map")?;
        let added = merge_by_id(&mut merged, &extra, &format!("map.{key}"), object_id)?;
        ensure_topic_capacity(&merged, &format!("map.{key}"))?;
        if key == "places" {
            places_added = added;
        }
        base.insert(key.to_string(), Value::Array(merged));
    }

    let mut routes = match base.remove("routes") {
        None | Some(Value::Null) => new_routes_object(),
        Some(Value::Object(routes)) => routes,
        Some(_) => {
            return Err(ApiError::new(
                "CORRUPTED",
                "shared/topics/map.json 的 routes 不是对象",
            ))
        }
    };
    let mut features = take_topic_array(&mut routes, "features", "map.json routes")?;
    let extra_features = incoming_route_features(incoming)?;
    merge_by_id(
        &mut features,
        &extra_features,
        "map.routes.features",
        feature_id,
    )?;
    ensure_topic_capacity(&features, "map.routes.features")?;
    routes.insert("features".to_string(), Value::Array(features));
    routes
        .entry("type".to_string())
        .or_insert_with(|| json!("FeatureCollection"));
    base.insert("routes".to_string(), Value::Object(routes));

    write_merged_topic(&path, existing.as_ref(), base)?;
    Ok(places_added)
}

/// 合并 `shared/topics/timeline.json`：events 按 id 去重追加，
/// config.enabledArticleIds 取并集，config 其余字段保留已有值。返回新增事件数。
fn merge_timeline_topics(
    books_root: &Path,
    book_id: &str,
    incoming: &Map<String, Value>,
) -> Result<usize, ApiError> {
    let path = books_root
        .join(book_id)
        .join("shared")
        .join("topics")
        .join("timeline.json");
    let existing = read_json_opt(&path)?;
    let mut base = match &existing {
        Some(Value::Object(object)) => object.clone(),
        Some(_) => {
            return Err(ApiError::new(
                "CORRUPTED",
                "shared/topics/timeline.json 顶层不是 JSON 对象",
            ))
        }
        None => new_timeline_object(book_id),
    };
    base.insert("schemaVersion".to_string(), json!(TOPICS_SCHEMA_VERSION));
    base.insert("bookId".to_string(), json!(book_id));

    let mut events = take_topic_array(&mut base, "events", "timeline.json")?;
    let extra_events = match incoming.get("events") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(ApiError::invalid("timeline.events 必须是数组")),
    };
    let events_added = merge_by_id(&mut events, &extra_events, "timeline.events", object_id)?;
    ensure_topic_capacity(&events, "timeline.events")?;
    base.insert("events".to_string(), Value::Array(events));

    let mut config = match base.remove("config") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(config)) => config,
        Some(_) => {
            return Err(ApiError::new(
                "CORRUPTED",
                "shared/topics/timeline.json 的 config 不是对象",
            ))
        }
    };
    if let Some(incoming_config) = match incoming.get("config") {
        None | Some(Value::Null) => None,
        Some(Value::Object(config)) => Some(config),
        Some(_) => return Err(ApiError::invalid("timeline.config 必须是对象")),
    } {
        let enabled = match config.remove("enabledArticleIds") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items,
            Some(_) => {
                return Err(ApiError::new(
                    "CORRUPTED",
                    "shared/topics/timeline.json 的 config.enabledArticleIds 不是数组",
                ))
            }
        };
        let enabled = union_article_ids(enabled, incoming_config.get("enabledArticleIds"))?;
        config.insert("enabledArticleIds".to_string(), Value::Array(enabled));
        // 其余 config 字段（如 note）：已有值优先，缺省时用新值补齐。
        for (key, value) in incoming_config {
            if key != "enabledArticleIds" {
                config.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    base.insert("config".to_string(), Value::Object(config));

    write_merged_topic(&path, existing.as_ref(), base)?;
    Ok(events_added)
}

fn new_map_object(book_id: &str) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("schemaVersion".to_string(), json!(TOPICS_SCHEMA_VERSION));
    object.insert("bookId".to_string(), json!(book_id));
    object.insert("themes".to_string(), json!([]));
    object.insert("places".to_string(), json!([]));
    object.insert("routes".to_string(), Value::Object(new_routes_object()));
    object
}

fn new_timeline_object(book_id: &str) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("schemaVersion".to_string(), json!(TOPICS_SCHEMA_VERSION));
    object.insert("bookId".to_string(), json!(book_id));
    object.insert("config".to_string(), json!({ "enabledArticleIds": [] }));
    object.insert("events".to_string(), json!([]));
    object
}

fn new_routes_object() -> Map<String, Value> {
    let mut routes = Map::new();
    routes.insert("type".to_string(), json!("FeatureCollection"));
    routes.insert("features".to_string(), json!([]));
    routes
}

/// 取出已有 topics 数组（缺省/null 视为空；类型不对视为文件损坏）。
fn take_topic_array(
    object: &mut Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Vec<Value>, ApiError> {
    match object.remove(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(ApiError::new(
            "CORRUPTED",
            format!("{label} 的 {key} 不是数组"),
        )),
    }
}

/// 读取本次 topics 数组（缺省视为空；出现则必须是数组）。
fn incoming_topic_array(
    object: &Map<String, Value>,
    key: &str,
    prefix: &str,
) -> Result<Vec<Value>, ApiError> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(_) => Err(ApiError::invalid(format!("{prefix}.{key} 必须是数组"))),
    }
}

fn incoming_route_features(map: &Map<String, Value>) -> Result<Vec<Value>, ApiError> {
    let Some(routes) = map.get("routes") else {
        return Ok(Vec::new());
    };
    let Some(routes) = routes.as_object() else {
        return Err(ApiError::invalid("map.routes 必须是对象"));
    };
    match routes.get("features") {
        None => Ok(Vec::new()),
        Some(Value::Array(features)) => Ok(features.clone()),
        Some(_) => Err(ApiError::invalid("map.routes.features 必须是数组")),
    }
}

/// 按 id 合并条目：先校验 incoming（对象 + 字符串 id），再去重追加。
/// 已有条目按 id 去重（保留首次出现），保证重复调用不会累积重复项。
fn merge_by_id(
    existing: &mut Vec<Value>,
    incoming: &[Value],
    label: &str,
    id_of: fn(&Value) -> Option<&str>,
) -> Result<usize, ApiError> {
    for value in incoming {
        if !value.is_object() {
            return Err(ApiError::invalid(format!("{label} 条目必须是 JSON 对象")));
        }
        let id =
            id_of(value).ok_or_else(|| ApiError::invalid(format!("{label} 条目缺少字符串 id")))?;
        if id.chars().count() > ID_MAX_CHARS {
            return Err(ApiError::invalid(format!(
                "{label} 的 id 过长（≤{ID_MAX_CHARS} 字符）"
            )));
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    existing.retain(|value| match id_of(value) {
        Some(id) => seen.insert(id.to_string()),
        None => true,
    });
    let mut added = 0usize;
    for value in incoming {
        if let Some(id) = id_of(value) {
            if seen.insert(id.to_string()) {
                existing.push(value.clone());
                added += 1;
            }
        }
    }
    Ok(added)
}

fn object_id(value: &Value) -> Option<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn feature_id(value: &Value) -> Option<&str> {
    value
        .get("properties")
        .and_then(|properties| properties.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn ensure_topic_capacity(items: &[Value], label: &str) -> Result<(), ApiError> {
    if items.len() > MAX_TOPIC_ENTRIES {
        return Err(ApiError::invalid(format!(
            "{label} 条目数超过上限（{MAX_TOPIC_ENTRIES}）"
        )));
    }
    Ok(())
}

/// enabledArticleIds 并集：已有（字符串项）在前，新值追加去重；新值类型严格校验。
fn union_article_ids(
    existing: Vec<Value>,
    incoming: Option<&Value>,
) -> Result<Vec<Value>, ApiError> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut ids: Vec<Value> = Vec::new();
    for item in &existing {
        if let Some(id) = item.as_str() {
            let id = id.trim();
            if !id.is_empty() && id.chars().count() <= ID_MAX_CHARS && seen.insert(id.to_string()) {
                ids.push(json!(id));
            }
        }
    }
    if let Some(value) = incoming {
        let items = value.as_array().ok_or_else(|| {
            ApiError::invalid("timeline.config.enabledArticleIds 必须是字符串数组")
        })?;
        if items.len() > MAX_TOPIC_ENTRIES {
            return Err(ApiError::invalid(format!(
                "timeline.config.enabledArticleIds 条目数超过上限（{MAX_TOPIC_ENTRIES}）"
            )));
        }
        for item in items {
            let id = item
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.chars().count() <= ID_MAX_CHARS)
                .ok_or_else(|| {
                    ApiError::invalid(
                        "timeline.config.enabledArticleIds 含非法条目（需 1–200 字符字符串）",
                    )
                })?;
            if seen.insert(id.to_string()) {
                ids.push(json!(id));
            }
        }
    }
    Ok(ids)
}

/// topics 写盘：内容有变化才写；`generatedAt` 首次创建或内容变化时刷新。
fn write_merged_topic(
    path: &Path,
    existing: Option<&Value>,
    base: Map<String, Value>,
) -> Result<(), ApiError> {
    let mut merged = Value::Object(base);
    let content_changed = existing != Some(&merged);
    let has_generated_at = merged
        .get("generatedAt")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    if content_changed || !has_generated_at {
        merged["generatedAt"] = json!(now_rfc3339());
    }
    if existing != Some(&merged) {
        write_json(path, &merged)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 章节探索投影合并（chapters/<id>/explore.json）
// ---------------------------------------------------------------------------

/// 合并单章 `explore.json`：数组并集、focus 保留已有值；无变化不重写。
fn merge_chapter_explore(
    books_root: &Path,
    book_id: &str,
    input: &ExploreInput,
) -> Result<(), ApiError> {
    let path = books_root
        .join(book_id)
        .join("chapters")
        .join(&input.chapter_id)
        .join("explore.json");
    let existing = read_explore_lenient(&path);
    let existing_object = existing.as_ref().and_then(Value::as_object);

    let map = merge_explore_map(
        existing_object.and_then(|object| object.get("map")),
        input.map.as_ref(),
    );
    let timeline = merge_explore_timeline(
        existing_object.and_then(|object| object.get("timeline")),
        input.timeline.as_ref(),
    );
    let merged = json!({
        "schemaVersion": TOPICS_SCHEMA_VERSION,
        "bookId": book_id,
        "chapterId": input.chapter_id,
        "map": map,
        "timeline": timeline,
    });
    if existing.as_ref() != Some(&merged) {
        write_json(&path, &merged)?;
    }
    Ok(())
}

/// 读取既有 explore.json：缺失/损坏/schemaVersion 不符一律视为没有（派生投影可重建）。
fn read_explore_lenient(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(TOPICS_SCHEMA_VERSION) {
        return None;
    }
    value.is_object().then_some(value)
}

fn merge_explore_map(existing: Option<&Value>, incoming: Option<&ExploreMapInput>) -> Value {
    let existing_object = existing.and_then(Value::as_object);
    if existing_object.is_none() && incoming.is_none() {
        return Value::Null;
    }
    let empty: Vec<String> = Vec::new();
    let place_ids = union_ids(
        existing_object.and_then(|object| object.get("placeIds")),
        incoming.map_or(empty.as_slice(), |input| input.place_ids.as_slice()),
    );
    let route_ids = union_ids(
        existing_object.and_then(|object| object.get("routeIds")),
        incoming.map_or(empty.as_slice(), |input| input.route_ids.as_slice()),
    );
    let theme_ids = union_ids(
        existing_object.and_then(|object| object.get("themeIds")),
        incoming.map_or(empty.as_slice(), |input| input.theme_ids.as_slice()),
    );
    // focus：保留已有值；已有缺失/非法时用本次新值。
    let focus = existing_object
        .and_then(|object| object.get("focus"))
        .and_then(focus_value)
        .or_else(|| incoming.and_then(|input| input.focus.clone()))
        .unwrap_or(Value::Null);
    json!({
        "placeIds": place_ids,
        "routeIds": route_ids,
        "themeIds": theme_ids,
        "focus": focus,
    })
}

fn merge_explore_timeline(existing: Option<&Value>, incoming: Option<&Vec<String>>) -> Value {
    let existing_object = existing.and_then(Value::as_object);
    if existing_object.is_none() && incoming.is_none() {
        return Value::Null;
    }
    let empty: Vec<String> = Vec::new();
    let event_ids = union_ids(
        existing_object.and_then(|object| object.get("eventIds")),
        incoming.map_or(empty.as_slice(), |ids| ids.as_slice()),
    );
    json!({ "eventIds": event_ids })
}

/// 既有 id 数组（宽松读取：非法项丢弃）与本次 id 取并集，保持先出现顺序并去重。
fn union_ids(existing: Option<&Value>, incoming: &[String]) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut ids: Vec<Value> = Vec::new();
    let existing_items: Vec<&Value> = existing
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    for item in existing_items {
        if let Some(id) = item.as_str() {
            let id = id.trim();
            if !id.is_empty() && id.chars().count() <= ID_MAX_CHARS && seen.insert(id.to_string()) {
                ids.push(json!(id));
            }
        }
    }
    for id in incoming {
        if seen.insert(id.clone()) {
            ids.push(json!(id));
        }
    }
    ids
}

// ---------------------------------------------------------------------------
// 单元测试：只用临时目录（不碰 data/library）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::now_millis;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jusong-import-build-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(root.join("books")).unwrap();
        root
    }

    /// 写一本最小合法书（schemaVersion 2 + chapterIds），返回书籍目录。
    fn write_book(books: &Path, book_id: &str, chapter_ids: &[&str]) -> PathBuf {
        let directory = books.join(book_id);
        fs::create_dir_all(&directory).unwrap();
        let book = json!({
            "id": book_id,
            "title": format!("构建测试书 {book_id}"),
            "schemaVersion": 2,
            "chapterIds": chapter_ids,
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        directory
    }

    fn error_code<T>(result: Result<T, ApiError>) -> &'static str {
        match result {
            Ok(_) => panic!("预期返回错误，实际成功"),
            Err(error) => error.code,
        }
    }

    fn empty_book_payload() -> (Value, Value, Vec<Value>) {
        (
            json!({
                "schemaVersion": 1,
                "themes": [{ "id": "agent-build", "name": "AGENT 构建", "color": "#8c2f1e" }],
                "places": [
                    { "id": "place-a", "name": "地点 A", "lon": 113.2, "lat": 23.1, "themes": ["agent-build"] },
                    { "id": "place-b", "name": "地点 B", "lon": 114.0, "lat": 22.5, "themes": ["agent-build"] },
                ],
                "routes": { "type": "FeatureCollection", "features": [
                    { "type": "Feature", "properties": { "id": "route-1" }, "geometry": { "type": "LineString", "coordinates": [] } },
                ] },
            }),
            json!({
                "schemaVersion": 1,
                "config": { "note": "AGENT 构建", "enabledArticleIds": ["ch_a"] },
                "events": [{ "id": "evt-1", "date": "1921-07-01", "title": "事件一", "articleIds": ["ch_a"], "placeIds": ["place-a"], "importance": 3 }],
            }),
            vec![
                json!({
                    "chapterId": "ch_a",
                    "map": { "placeIds": ["place-a"], "routeIds": ["route-1"], "themeIds": ["agent-build"], "focus": { "lon": 113.2, "lat": 23.1, "zoom": 6 } },
                    "timeline": { "eventIds": ["evt-1"] },
                }),
                json!({ "chapterId": "ch_b", "map": null, "timeline": { "eventIds": ["evt-1"] } }),
            ],
        )
    }

    #[test]
    fn apply_merges_topics_and_explores_idempotently() {
        let root = temp_root("merge");
        let books = root.join("books");
        let book_id = "buildbook-01";
        let directory = write_book(&books, book_id, &["ch_a", "ch_b"]);
        let (map, timeline, explores) = empty_book_payload();

        let result =
            apply_agent_knowledge_into(&books, book_id, Some(&map), Some(&timeline), &explores)
                .expect("apply agent knowledge");
        assert_eq!(result["places"], json!(2));
        assert_eq!(result["events"], json!(1));
        assert_eq!(result["explores"], json!(2));

        let map_file = read_json_opt(&directory.join("shared/topics/map.json"))
            .unwrap()
            .unwrap();
        assert_eq!(map_file["schemaVersion"], json!(1));
        assert_eq!(map_file["bookId"], json!(book_id));
        assert!(map_file["generatedAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(map_file["themes"].as_array().unwrap().len(), 1);
        assert_eq!(map_file["places"].as_array().unwrap().len(), 2);
        assert_eq!(map_file["places"][1]["id"], json!("place-b"));
        assert_eq!(
            map_file["routes"]["features"][0]["properties"]["id"],
            json!("route-1")
        );
        assert!(!directory.join("shared/topics/map.json.tmp").exists());

        let timeline_file = read_json_opt(&directory.join("shared/topics/timeline.json"))
            .unwrap()
            .unwrap();
        assert_eq!(timeline_file["events"].as_array().unwrap().len(), 1);
        assert_eq!(timeline_file["events"][0]["id"], json!("evt-1"));
        assert_eq!(
            timeline_file["config"]["enabledArticleIds"],
            json!(["ch_a"])
        );
        assert_eq!(timeline_file["config"]["note"], json!("AGENT 构建"));

        let explore_a = read_json_opt(&directory.join("chapters/ch_a/explore.json"))
            .unwrap()
            .unwrap();
        assert_eq!(explore_a["schemaVersion"], json!(1));
        assert_eq!(explore_a["bookId"], json!(book_id));
        assert_eq!(explore_a["chapterId"], json!("ch_a"));
        assert_eq!(explore_a["map"]["placeIds"], json!(["place-a"]));
        assert_eq!(explore_a["map"]["routeIds"], json!(["route-1"]));
        assert_eq!(explore_a["map"]["themeIds"], json!(["agent-build"]));
        assert_eq!(explore_a["map"]["focus"]["lon"], json!(113.2));
        assert_eq!(explore_a["map"]["focus"]["zoom"], json!(6.0));
        assert_eq!(explore_a["timeline"]["eventIds"], json!(["evt-1"]));

        let explore_b = read_json_opt(&directory.join("chapters/ch_b/explore.json"))
            .unwrap()
            .unwrap();
        assert!(explore_b["map"].is_null());
        assert_eq!(explore_b["timeline"]["eventIds"], json!(["evt-1"]));

        // 幂等：同一 payload 重放不新增条目，文件字节不变（不刷新 generatedAt）。
        let map_bytes = fs::read(directory.join("shared/topics/map.json")).unwrap();
        let timeline_bytes = fs::read(directory.join("shared/topics/timeline.json")).unwrap();
        let explore_bytes = fs::read(directory.join("chapters/ch_a/explore.json")).unwrap();
        let again =
            apply_agent_knowledge_into(&books, book_id, Some(&map), Some(&timeline), &explores)
                .expect("replay apply");
        assert_eq!(again["places"], json!(0));
        assert_eq!(again["events"], json!(0));
        assert_eq!(again["explores"], json!(2));
        assert_eq!(
            fs::read(directory.join("shared/topics/map.json")).unwrap(),
            map_bytes
        );
        assert_eq!(
            fs::read(directory.join("shared/topics/timeline.json")).unwrap(),
            timeline_bytes
        );
        assert_eq!(
            fs::read(directory.join("chapters/ch_a/explore.json")).unwrap(),
            explore_bytes
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_preserves_existing_entries_and_unions_ids() {
        let root = temp_root("preserve");
        let books = root.join("books");
        let book_id = "buildbook-02";
        let directory = write_book(&books, book_id, &["ch_a"]);

        // 预置既有 topics / explore：既有 place-a 名称与本次不同，应按 id 保留旧条目。
        write_json(
            &directory.join("shared/topics/map.json"),
            &json!({
                "schemaVersion": 1,
                "bookId": book_id,
                "generatedAt": "2026-01-01T00:00:00.000Z",
                "themes": [{ "id": "legacy-theme", "name": "旧主题", "color": "#111111" }],
                "places": [{ "id": "place-a", "name": "旧地点 A", "lon": 0.0, "lat": 0.0, "themes": ["legacy-theme"] }],
                "routes": { "type": "FeatureCollection", "features": [
                    { "type": "Feature", "properties": { "id": "route-old" }, "geometry": { "type": "LineString", "coordinates": [] } },
                ] },
            }),
        )
        .unwrap();
        write_json(
            &directory.join("chapters/ch_a/explore.json"),
            &json!({
                "schemaVersion": 1,
                "bookId": book_id,
                "chapterId": "ch_a",
                "map": { "placeIds": ["place-old"], "routeIds": [], "themeIds": ["legacy-theme"], "focus": { "lon": 1.0, "lat": 2.0, "zoom": 3 } },
                "timeline": Value::Null,
            }),
        )
        .unwrap();

        let map = json!({
            "themes": [{ "id": "agent-build", "name": "AGENT 构建", "color": "#8c2f1e" }],
            "places": [
                { "id": "place-a", "name": "新地点 A（不应覆盖旧值）", "lon": 9.9, "lat": 9.9, "themes": [] },
                { "id": "place-c", "name": "地点 C", "lon": 3.0, "lat": 4.0, "themes": ["agent-build"] },
            ],
        });
        let explores = vec![json!({
            "chapterId": "ch_a",
            "map": { "placeIds": ["place-c"], "themeIds": ["agent-build"], "focus": { "lon": 9.0, "lat": 9.0 } },
            "timeline": { "eventIds": ["evt-9"] },
        })];
        let result =
            apply_agent_knowledge_into(&books, book_id, Some(&map), None, &explores).unwrap();
        // place-a 已存在 → 只新增 place-c。
        assert_eq!(result["places"], json!(1));
        assert_eq!(result["events"], json!(0));
        assert_eq!(result["explores"], json!(1));

        let map_file = read_json_opt(&directory.join("shared/topics/map.json"))
            .unwrap()
            .unwrap();
        let places = map_file["places"].as_array().unwrap();
        assert_eq!(places.len(), 2);
        assert_eq!(places[0]["id"], json!("place-a"));
        assert_eq!(places[0]["name"], json!("旧地点 A"), "既有条目字段保留");
        assert_eq!(places[1]["id"], json!("place-c"));
        assert_eq!(map_file["themes"][0]["id"], json!("legacy-theme"));
        assert_eq!(map_file["themes"][1]["id"], json!("agent-build"));
        assert_eq!(
            map_file["routes"]["features"][0]["properties"]["id"],
            json!("route-old")
        );

        let explore = read_json_opt(&directory.join("chapters/ch_a/explore.json"))
            .unwrap()
            .unwrap();
        assert_eq!(
            explore["map"]["placeIds"],
            json!(["place-old", "place-c"]),
            "既有 id 在前，新 id 追加"
        );
        assert_eq!(
            explore["map"]["themeIds"],
            json!(["legacy-theme", "agent-build"])
        );
        assert_eq!(
            explore["map"]["focus"]["lon"],
            json!(1.0),
            "focus 保留已有值"
        );
        assert_eq!(explore["map"]["focus"]["zoom"], json!(3.0));
        assert_eq!(explore["timeline"]["eventIds"], json!(["evt-9"]));

        // 没有传入 timeline 时不创建 timeline.json（也不误删已有文件）。
        assert!(!directory.join("shared/topics/timeline.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_rejects_invalid_input_without_writing() {
        let root = temp_root("invalid");
        let books = root.join("books");
        let book_id = "buildbook-03";
        let directory = write_book(&books, book_id, &["ch_a"]);

        // 书不存在 / 非法 bookId。
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                "missing-book-1",
                None,
                None,
                &[]
            )),
            "NOT_FOUND"
        );
        // map/timeline 顶层必须对象或 null。
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                Some(&json!("坏数据")),
                None,
                &[]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                None,
                Some(&json!([1, 2])),
                &[]
            )),
            "INVALID_INPUT"
        );
        // explores：非对象 / 缺 chapterId / 非法格式 / 不属于本书。
        for explore in [
            json!("ch_a"),
            json!({ "map": null }),
            json!({ "chapterId": "bad id", "map": null }),
            json!({ "chapterId": "ch_x", "map": null }),
        ] {
            assert_eq!(
                error_code(apply_agent_knowledge_into(
                    &books,
                    book_id,
                    None,
                    None,
                    &[explore]
                )),
                "INVALID_INPUT"
            );
        }
        // explore 内部类型严格校验。
        for explore in [
            json!({ "chapterId": "ch_a", "map": "地点" }),
            json!({ "chapterId": "ch_a", "map": { "placeIds": "place-a" } }),
            json!({ "chapterId": "ch_a", "map": { "placeIds": [42] } }),
            json!({ "chapterId": "ch_a", "map": { "focus": { "lon": 999, "lat": 0 } } }),
            json!({ "chapterId": "ch_a", "timeline": [] }),
            json!({ "chapterId": "ch_a", "timeline": { "eventIds": [true] } }),
        ] {
            assert_eq!(
                error_code(apply_agent_knowledge_into(
                    &books,
                    book_id,
                    None,
                    None,
                    &[explore]
                )),
                "INVALID_INPUT"
            );
        }
        // topics 条目：非对象 / 缺 id / 非法 config。
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                Some(&json!({ "places": ["place-a"] })),
                None,
                &[]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                Some(&json!({ "places": [{ "name": "缺 id" }] })),
                None,
                &[]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                Some(
                    &json!({ "routes": { "features": [{ "type": "Feature", "properties": {} }] } })
                ),
                None,
                &[]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                None,
                Some(&json!({ "config": { "enabledArticleIds": "ch_a" }, "events": [] })),
                &[]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                None,
                Some(&json!({ "events": [{ "title": "缺 id" }] })),
                &[]
            )),
            "INVALID_INPUT"
        );

        // 以上非法调用都不应写盘（含创建目录）。
        assert!(!directory.join("shared/topics/map.json").exists());
        assert!(!directory.join("shared/topics/timeline.json").exists());
        assert!(!directory.join("chapters/ch_a/explore.json").exists());

        // null 入参合法：不写文件、计数为 0。
        let empty = apply_agent_knowledge_into(
            &books,
            book_id,
            Some(&Value::Null),
            Some(&Value::Null),
            &[],
        )
        .unwrap();
        assert_eq!(empty, json!({ "places": 0, "events": 0, "explores": 0 }));
        assert!(!directory.join("shared/topics/map.json").exists());
        assert!(!directory.join("shared/topics/timeline.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_errors_on_corrupted_topic_files() {
        let root = temp_root("corrupted");
        let books = root.join("books");
        let book_id = "buildbook-04";
        let directory = write_book(&books, book_id, &["ch_a"]);

        write_json(
            &directory.join("shared/topics/map.json"),
            &json!([{ "id": "place-a" }]),
        )
        .unwrap();
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                Some(&json!({ "places": [] })),
                None,
                &[]
            )),
            "CORRUPTED"
        );

        write_json(&directory.join("shared/topics/map.json"), &json!({})).unwrap();
        write_json(
            &directory.join("shared/topics/timeline.json"),
            &json!({ "config": "坏" }),
        )
        .unwrap();
        assert_eq!(
            error_code(apply_agent_knowledge_into(
                &books,
                book_id,
                None,
                Some(&json!({ "events": [] })),
                &[]
            )),
            "CORRUPTED"
        );

        // 损坏的 explore.json 视为缺失（派生投影可重建），不阻断写入。
        fs::create_dir_all(directory.join("chapters/ch_a")).unwrap();
        fs::write(directory.join("chapters/ch_a/explore.json"), "{ not json").unwrap();
        let result = apply_agent_knowledge_into(
            &books,
            book_id,
            None,
            None,
            &[json!({ "chapterId": "ch_a", "timeline": { "eventIds": ["evt-1"] } })],
        )
        .unwrap();
        assert_eq!(result["explores"], json!(1));
        let explore = read_json_opt(&directory.join("chapters/ch_a/explore.json"))
            .unwrap()
            .unwrap();
        assert!(explore["map"].is_null());
        assert_eq!(explore["timeline"]["eventIds"], json!(["evt-1"]));

        let _ = fs::remove_dir_all(root);
    }
}
