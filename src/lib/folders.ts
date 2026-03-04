/// <reference path="../types/thunderbird.d.ts" />

export async function getOrCreateLocalFolder(
  folderName: string
): Promise<browser.MailFolder | undefined> {
  const accounts = await browser.accounts.list();

  // Find "Local Folders" account (type "none")
  const localAccount = accounts.find((acc) => acc.type === "none");
  if (!localAccount) {
    console.warn("[PostGuard] No Local Folders account found. Account types:", accounts.map(a => `${a.name}(${a.type})`));
    return undefined;
  }

  // Search subfolders for existing folder
  try {
    const subFolders = await browser.folders.getSubFolders(localAccount as any);
    const existing = subFolders.find((f) => f.name === folderName);
    if (existing) return existing;
  } catch (e) {
    console.warn("[PostGuard] Could not list subfolders:", e);
  }

  // Create the folder
  try {
    return await browser.folders.create(localAccount as any, folderName);
  } catch (e) {
    console.error("[PostGuard] Could not create folder:", e);
    return undefined;
  }
}
