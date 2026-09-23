import './ui/style.css';
import { ApiClient } from './api/client';
import { KdsApp } from './app';
import { loadConfig, withAdvertisedRealtime, type KdsConfig } from './config';
import { DeviceStorage } from './device/storage';
import { KdsRealtime } from './realtime/kds-realtime';
import { mountShell } from './ui/shell';
import { WebAudioChime } from './ui/sound';

const root = document.querySelector<HTMLDivElement>('#app');
if (root === null) throw new Error('#app element missing');

async function start(target: HTMLElement): Promise<void> {
  let config: KdsConfig;
  try {
    config = await loadConfig();
  } catch (e) {
    target.textContent = `Invalid kiosk configuration: ${e instanceof Error ? e.message : String(e)}`;
    target.className = 'fatal';
    return;
  }
  // Unless configured explicitly, take the Reverb host/port/key the node advertises.
  if (!config.reverbExplicit) {
    try {
      const info = await new ApiClient({ baseUrl: config.apiBaseUrl }).getSystemInfo();
      config = withAdvertisedRealtime(config, info.realtime);
    } catch {
      /* server not reachable yet: keep derived defaults */
    }
  }
  const finalConfig = config;

  const chime = new WebAudioChime();
  const app = new KdsApp({
    config: finalConfig,
    storage: new DeviceStorage(),
    chime,
    makeApi: (hooks) => new ApiClient({ baseUrl: finalConfig.apiBaseUrl, ...hooks }),
    makeRealtime: (hooks, handlers) =>
      new KdsRealtime(
        {
          reverb: finalConfig.reverb,
          authUrl: `${finalConfig.apiBaseUrl}/api/v1/broadcasting/auth`,
          ...hooks,
        },
        handlers,
      ),
  });
  app.boot();
  mountShell(target, app, chime);
}

void start(root);
