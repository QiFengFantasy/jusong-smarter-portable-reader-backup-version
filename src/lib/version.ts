import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * 产品版本号（来自 tauri.conf.json version，构建前由 scripts/version.mjs 递增第三段）。
 * 非 Tauri 环境（纯 dev 浏览器）回退到占位版本。
 */
export function useAppVersion(fallback = "0.1.0"): string {
  const [version, setVersion] = useState(fallback);

  useEffect(() => {
    let alive = true;
    getVersion()
      .then((next) => {
        if (alive && next) setVersion(next);
      })
      .catch(() => {
        // 浏览器预览无 Tauri API，保留 fallback
      });
    return () => {
      alive = false;
    };
  }, []);

  return version;
}
