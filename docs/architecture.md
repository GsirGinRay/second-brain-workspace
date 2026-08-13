# Architecture

```text
Any Markdown editor
        ↕
Second Brain Workspace Desktop
        ↕ optional structured sync
Compatible cloud adapter
        ↕
Phone or browser UI
```

The desktop application and Markdown workflow are complete without a server.
Cloud sync is an optional capability, not the product foundation.

`brain-core` owns the durable Markdown format and merge rules. `brain-ui` owns
portable calendar and repository contracts. The desktop app owns native file
access, backups, watchers, device keys and recovery.

Publisher is one private deployment that can implement the cloud protocol. It
is not part of this open-source repository and is not required by the desktop
application.
