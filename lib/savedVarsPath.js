// Where ESO keeps ItemShareSavedVars.lua, worked out from the home directory
// instead of from a hard-coded drive letter.
//
// os.homedir() is the OS-agnostic base: on Windows it reads %USERPROFILE%, so a
// Users folder that has been moved to another drive (D:\Users\skper) is respected;
// on macOS and Linux it reads $HOME and falls back to the passwd entry when HOME is
// unset. Nothing here assumes a drive letter or a separator.

import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SAVED_VARIABLES_FILE = 'ItemShareSavedVars.lua';

const ESO_FOLDER = 'Elder Scrolls Online';
// One folder per server: live is the usual one, liveeu the European megaserver and
// pts the test server. All three are checked, in that order.
const SERVER_FOLDERS = ['live', 'liveeu', 'pts'];

export function homeDirectory(env = process.env) {
  try {
    const home = os.homedir();
    if (home) {
      return home;
    }
  } catch {
    // Older Node builds can throw here when no home is known; fall through to env.
  }
  return env.USERPROFILE || env.HOME || '';
}

/**
 * The folders that could be "Documents" for this user, most likely first.
 */
export function documentsDirectories(env = process.env) {
  const home = homeDirectory(env);
  const candidates = [];
  const add = (directory) => {
    if (directory && !candidates.includes(directory)) {
      candidates.push(directory);
    }
  };

  // Windows can move Documents into OneDrive, and the game follows it there. The
  // variable is the only reliable sign; asking the registry would mean a dependency
  // for one path.
  add(env.OneDrive && path.join(env.OneDrive, 'Documents'));
  add(env.OneDriveConsumer && path.join(env.OneDriveConsumer, 'Documents'));
  add(env.OneDriveCommercial && path.join(env.OneDriveCommercial, 'Documents'));

  if (home) {
    add(path.join(home, 'Documents'));
    add(path.join(home, 'OneDrive', 'Documents'));

    // ESO on Linux runs under Steam Proton, where the game's Documents folder lives
    // inside the prefix rather than in $HOME. 306130 is ESO's Steam app id.
    const protonDocuments = [
      path.join(home, '.steam', 'steam', 'steamapps', 'compatdata', '306130', 'pfx', 'drive_c', 'users', 'steamuser', 'Documents'),
      path.join(home, '.local', 'share', 'Steam', 'steamapps', 'compatdata', '306130', 'pfx', 'drive_c', 'users', 'steamuser', 'Documents'),
    ];
    for (const directory of protonDocuments) {
      add(directory);
    }
  }

  return candidates;
}

/**
 * Every file path worth trying, in the order worth trying it: the answers are printed
 * when nothing is found, so a user can see where the search went.
 */
export function savedVariablesCandidates(env = process.env) {
  const files = [];

  for (const documents of documentsDirectories(env)) {
    for (const server of SERVER_FOLDERS) {
      files.push(path.join(documents, ESO_FOLDER, server, 'SavedVariables', SAVED_VARIABLES_FILE));
    }
  }

  return files;
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first candidate that actually exists, or an empty string.
 */
export async function findSavedVariablesFile(env = process.env) {
  for (const candidate of savedVariablesCandidates(env)) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return '';
}
