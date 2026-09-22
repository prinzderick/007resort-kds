/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_R007_API_BASE_URL?: string;
  readonly VITE_KDS_STATION_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
