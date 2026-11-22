mod agent;
mod bookmarks;
mod cover;
mod import_build;
mod library;
mod transfer;
mod util;

use agent::{
    agent_cancel, agent_chat, agent_clear_key, agent_get_session, agent_save_session,
    agent_set_config, agent_status,
};
use bookmarks::{
    library_add_bookmark, library_delete_bookmark, library_delete_bookmarks,
    library_list_bookmarks, library_update_bookmark, library_update_bookmark_orders,
};
use cover::library_get_book_cover;
use import_build::library_apply_agent_knowledge;
use library::{
    library_add_knowledge, library_cancel_search, library_ensure_seed, library_get_book,
    library_get_book_topics, library_get_chapter, library_get_chapter_assets,
    library_get_chapter_digest, library_get_chapter_explore, library_get_knowledge,
    library_get_recent_books, library_get_settings, library_get_toc, library_import_epub,
    library_info, library_list_books, library_list_chapter_digests, library_list_knowledge,
    library_read_epub, library_record_recent_book, library_save_chapter_digest,
    library_save_settings, library_search,
};
use transfer::{
    library_book_transfer_info, library_export_book, library_import_original,
    library_import_package,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_info,
            library_ensure_seed,
            library_list_books,
            library_get_book,
            library_get_toc,
            library_get_chapter,
            library_get_chapter_digest,
            library_list_chapter_digests,
            library_get_chapter_explore,
            library_list_knowledge,
            library_get_knowledge,
            library_add_knowledge,
            library_apply_agent_knowledge,
            library_get_chapter_assets,
            library_get_book_topics,
            library_read_epub,
            library_import_epub,
            library_save_chapter_digest,
            library_get_settings,
            library_save_settings,
            library_search,
            library_cancel_search,
            library_get_recent_books,
            library_record_recent_book,
            library_get_book_cover,
            library_list_bookmarks,
            library_add_bookmark,
            library_update_bookmark,
            library_delete_bookmark,
            library_delete_bookmarks,
            library_update_bookmark_orders,
            library_import_original,
            library_import_package,
            library_book_transfer_info,
            library_export_book,
            agent_status,
            agent_set_config,
            agent_clear_key,
            agent_chat,
            agent_cancel,
            agent_get_session,
            agent_save_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
