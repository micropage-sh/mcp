/**
 * Endpoints the server talks to. Same defaults and the same MICROPAGE_*
 * overrides as the CLI (cli/src/config.js), so a developer pointing the CLI
 * at a local stack points the MCP server there with the same env.
 */
export interface MicropageConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appUrl: string;
  buildCompilerUrl: string;
  baseDomain: string;
}

// Public anon key, identical to the one the web app and CLI ship.
const DEFAULT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZobGlmY2RzbG5tbnZudm9ybHV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjUxMTUzMTMsImV4cCI6MjA0MDY5MTMxM30.IprHOpa397Wcv5iFwa_e9hkXhhmXYZFXC4BF_qGYkkk";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MicropageConfig {
  return {
    supabaseUrl: env.MICROPAGE_SUPABASE_URL || "https://vhlifcdslnmnvnvorluu.supabase.co",
    supabaseAnonKey: env.MICROPAGE_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY,
    appUrl: env.MICROPAGE_APP_URL || "https://app.micropage.sh",
    buildCompilerUrl:
      env.MICROPAGE_BUILD_COMPILER_URL ||
      env.MICROPAGE_PARSER_URL ||
      "https://build-compiler.micropage.sh",
    baseDomain: env.MICROPAGE_BASE_DOMAIN || "micropage.sh",
  };
}

/**
 * Live URL for a project: the custom domain when set, else
 * https://<slug>.<baseDomain>. Null when there is nothing to build one from.
 */
export function projectUrl(
  config: Pick<MicropageConfig, "baseDomain">,
  slug: string | null | undefined,
  customDomain?: string | null,
): string | null {
  const cd = customDomain?.trim();
  if (cd) return /^https?:\/\//.test(cd) ? cd : `https://${cd}`;
  const s = slug?.trim();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) return s;
  return `https://${s}.${config.baseDomain}`;
}
