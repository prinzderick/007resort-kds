/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OTUEKE_API_BASE_URL?: string;
  readonly VITE_KDS_STATION_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
