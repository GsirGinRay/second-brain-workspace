import React, { useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export function ExternalWebLink({ href, children, locale = "zh-TW" }: {
  href?: string;
  children: ReactNode;
  locale?: "zh-TW" | "en";
}) {
  const [failed, setFailed] = useState(false);
  let url: URL;
  try {
    url = new URL(href ?? "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return <span>{children}</span>;
  } catch {
    return <span>{children}</span>;
  }
  return <>
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (!isTauri()) return;
        event.preventDefault();
        setFailed(false);
        void invoke("open_external_url", { url: url.href }).catch(() => setFailed(true));
      }}
    >{children}</a>
    {failed && <span role="alert">{locale === "en" ? "Unable to open link. Please try again." : "無法開啟連結，請再試一次。"}</span>}
  </>;
}
