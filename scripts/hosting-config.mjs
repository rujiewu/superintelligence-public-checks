// Shared public identity; private credentials never belong in this file.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config/hosting.json', import.meta.url), 'utf8'));
const [owner, name] = config.public_repository.split('/');
if (config.schema_version !== '1.0.0' || config.site_base !== '/' + name
    || config.pages_origin !== `https://${owner}.github.io`
    || config.source_repository === config.public_repository
    || config.source_repository.split('/')[0] !== owner
    || (config.api_fallback_origin != null
      && config.api_fallback_origin !== 'https://reading-workspace-api.zippybox2.chatgpt.site')
    || config.api_origin !== `https://${config.gateway_project_name}-${config.vercel_team_slug}.vercel.app`) {
  throw new Error('Public hosting identity is inconsistent');
}
export const hosting = Object.freeze({ ...config, pages_url: config.pages_origin + config.site_base + '/' });
