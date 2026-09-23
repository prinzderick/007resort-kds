/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_R007_API_BASE_URL?: string;
  readonly VITE_R007_REVERB_HOST?: string;
  readonly VITE_R007_REVERB_PORT?: string;
  readonly VITE_R007_REVERB_SCHEME?: string;
  readonly VITE_R007_REVERB_KEY?: string;
  readonly VITE_KDS_STATION_CODE?: string;
  readonly VITE_KDS_WARN_MINUTES?: string;
  readonly VITE_KDS_LATE_MINUTES?: string;
  readonly VITE_KDS_IDLE_LOCK_SECONDS?: string;
  readonly VITE_KDS_RESYNC_SECONDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
