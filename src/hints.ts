/**
 * Model-facing wording that names how the user changes a setting or fixes a
 * login. The stdio server points at env switches and `micropage login`; a
 * hosted connection has neither, so it points at the micropage account page
 * or the MCP client's reconnect instead.
 */
export interface ModeHints {
  /** Completes "...whether this server is allowed to send email (<here>)." */
  sendSwitchName: string;
  /** Completes "...refused unless <here>;". */
  sendEnabledBy: string;
  /** Output field description of preview_post_send's send_allowed. */
  sendAllowedField: string;
  /** Why an emailing post was refused, and what the user can do about it. */
  sendDisabled: string;
  /** Last sentence of delete_project's description. */
  deleteAvailable: string;
  /** write_post prompt: the line about emailing subscribers. */
  promptSendRule: string;
  /** review_submissions prompt: the line about list_submissions being absent. */
  promptSubmissionsRule: string;
  /** whoami description: which kinds of credentials it reports. */
  whoamiModes: string;
  /** whoami description: what the note usually tells the user to do. */
  whoamiFix: string;
  /** whoami note when the token is rejected by the API. */
  loginInvalid: string;
  /** Appended to the deploy-token refusal: where the other tools are. */
  deployTokenElsewhere: string;
  /** Error when the API answers 401 even after a forced token refresh. */
  sessionInvalid: string;
  /** Error when the access token carries no user id. */
  tokenNoUser: string;
  /** Follows "The deploy token was rejected (<detail>)." on a refused exchange. */
  deployTokenCheck: string;
  /** Follows "No project with uuid <uuid> exists (<detail>)." on a refused exchange. */
  deployProjectCheck: string;
  /** upload_asset description: which source to prefer; empty when there is no preference. */
  uploadSourceNote: string;
}

export const STDIO_HINTS: ModeHints = Object.freeze({
  sendSwitchName: "MICROPAGE_MCP_ALLOW_SEND",
  sendEnabledBy: "the user has set MICROPAGE_MCP_ALLOW_SEND=1 in this server's config",
  sendAllowedField: "MICROPAGE_MCP_ALLOW_SEND is set, so this server may email subscribers.",
  sendDisabled:
    "Emailing from the MCP server is turned off. The user can turn it on by adding MICROPAGE_MCP_ALLOW_SEND=1 to this server's env in their MCP client config " +
    "and restarting it, or publish from the micropage editor or with `micropage posts publish`. To publish on the web only, save the post with email: false " +
    "(upsert_post), then call preview_post_send again.",
  deleteAvailable: "Available only because MICROPAGE_MCP_ALLOW_DELETE is set.",
  promptSendRule:
    "- Emailing subscribers needs MICROPAGE_MCP_ALLOW_SEND=1 in my MCP server config. If publish_post refuses to send because it is off, tell me; do not try to work around it.",
  promptSubmissionsRule:
    "If list_submissions is not available, submission access is off: it needs MICROPAGE_MCP_SUBMISSIONS=1 in my MCP server config. Tell me that rather than looking for another way in.",
  whoamiModes: "whether it runs on the user's `micropage login` session or on a project deploy token (and if so, which project it is pinned to)",
  whoamiFix: "usually run `micropage login` in a terminal",
  loginInvalid: "The micropage login session is no longer valid. Run `micropage login` in a terminal, then retry.",
  deployTokenElsewhere: "Use a full `micropage login` session for anything else.",
  sessionInvalid: "The micropage session is no longer valid. Ask the user to run `micropage login` in a terminal, then retry.",
  tokenNoUser: "The micropage access token has no user id. Run `micropage login` in a terminal, then retry.",
  deployTokenCheck:
    "Ask the user to check MICROPAGE_DEPLOY_TOKEN, or to create a new token in the micropage editor under Settings > Deploy tokens.",
  deployProjectCheck: "Ask the user to check MICROPAGE_DEPLOY_PROJECT.",
  uploadSourceNote: "",
});

export const CONNECTED_APPS_URL = "https://app.micropage.sh/account/connected-apps";
const CONNECTED_APPS = `Micropage → Connected AI apps (${CONNECTED_APPS_URL})`;
const RECONNECT =
  "Ask the user to reconnect (re-authenticate) the micropage connector in their AI app, then retry.";
const CHECK_CONNECTOR =
  "Ask the user to check the deploy token and the X-Micropage-Project header in the connector settings, then retry.";
const REMOTE_DEPLOY_TOKEN_CHECK =
  "Ask the user to check the deploy token in the AI app's connector settings, or to create a new token in the micropage editor under Settings > Deploy tokens.";
const REMOTE_DEPLOY_PROJECT_CHECK = "Ask the user to check the X-Micropage-Project header in the AI app's connector settings.";
// Base64 travels through the model's context and the request body, which is
// capped well below what a fetched URL may be.
const REMOTE_UPLOAD_SOURCE_NOTE =
  "Prefer source.url whenever the image is on a public https host; use source.base64 only for an image that is not hosted anywhere.";

/** A hosted connection authorized through OAuth: permissions live on the user's Connected AI apps page. */
export const REMOTE_OAUTH_HINTS: ModeHints = Object.freeze({
  sendSwitchName: "the 'Let it send newsletter emails' setting for this app",
  sendEnabledBy: `the user has turned on 'Let it send newsletter emails' for this app in ${CONNECTED_APPS}`,
  sendAllowedField: "The user turned on 'Let it send newsletter emails' for this app, so it may email subscribers.",
  sendDisabled:
    `Emailing from this app is turned off. The user can turn on 'Let it send newsletter emails' for this app in ${CONNECTED_APPS}, ` +
    "or publish from the micropage editor. To publish on the web only, save the post with email: false (upsert_post), then call preview_post_send again.",
  deleteAvailable: `Available only because the user turned on 'Let it delete projects' for this app in ${CONNECTED_APPS}.`,
  promptSendRule:
    `- Emailing subscribers needs 'Let it send newsletter emails' turned on for this app in ${CONNECTED_APPS}. If publish_post refuses to send because it is off, tell me; do not try to work around it.`,
  promptSubmissionsRule:
    `If list_submissions is not available, submission access is off: it needs 'Let it read form submissions' turned on for this app in ${CONNECTED_APPS}. Tell me that rather than looking for another way in.`,
  whoamiModes: "whether it runs on the user's connected-app authorization (OAuth) or on a project deploy token (and if so, which project it is pinned to)",
  whoamiFix: "usually reconnect the micropage connector in their AI app",
  loginInvalid: `The micropage authorization for this connection is no longer valid. ${RECONNECT}`,
  deployTokenElsewhere: "Connect micropage to the AI app with the user's micropage account for anything else.",
  sessionInvalid: `The micropage authorization for this connection is no longer valid. ${RECONNECT}`,
  tokenNoUser: `The micropage authorization for this connection has no user id. ${RECONNECT}`,
  deployTokenCheck: REMOTE_DEPLOY_TOKEN_CHECK,
  deployProjectCheck: REMOTE_DEPLOY_PROJECT_CHECK,
  uploadSourceNote: REMOTE_UPLOAD_SOURCE_NOTE,
});

/** A hosted connection on a project deploy token: no account-level settings apply. */
export const REMOTE_DEPLOY_TOKEN_HINTS: ModeHints = Object.freeze({
  sendSwitchName: "not available with a deploy token",
  sendEnabledBy: "the connection uses the user's micropage account (emailing is not available with a deploy token)",
  sendAllowedField: "Always false with a deploy token: emailing is not available with a deploy token.",
  sendDisabled:
    "Emailing subscribers is not available with a deploy token. The user can publish from the micropage editor. To publish on the web only, " +
    "save the post with email: false (upsert_post), then call preview_post_send again.",
  deleteAvailable: "Deleting projects is not available with a deploy token.",
  promptSendRule: "- Emailing subscribers is not available with a deploy token. If publish_post refuses to send, tell me; do not try to work around it.",
  promptSubmissionsRule:
    "If list_submissions is not available, that is because reading form submissions is not available with a deploy token. Tell me that rather than looking for another way in.",
  whoamiModes: "whether it runs on the user's connected-app authorization (OAuth) or on a project deploy token (and if so, which project it is pinned to)",
  whoamiFix: "usually check the deploy token and the X-Micropage-Project header in the AI app's connector settings",
  loginInvalid: `The deploy token was rejected. ${CHECK_CONNECTOR}`,
  deployTokenElsewhere: "Connect micropage to the AI app with the user's micropage account for anything else.",
  sessionInvalid: `The deploy-token session is no longer valid. ${CHECK_CONNECTOR}`,
  tokenNoUser: `The deploy-token session has no user id. ${CHECK_CONNECTOR}`,
  deployTokenCheck: REMOTE_DEPLOY_TOKEN_CHECK,
  deployProjectCheck: REMOTE_DEPLOY_PROJECT_CHECK,
  uploadSourceNote: REMOTE_UPLOAD_SOURCE_NOTE,
});
