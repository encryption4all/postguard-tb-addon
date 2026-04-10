// Server URLs, injected at build time from environment variables.
// The SDK handles all PKG and Cryptify communication internally.

export const PKG_URL = process.env.PKG_URL;
export const CRYPTIFY_URL = process.env.CRYPTIFY_URL;
export const POSTGUARD_WEBSITE_URL = process.env.POSTGUARD_WEBSITE_URL;
