#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=cargo,git,deno --allow-net --no-check
// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.
import { DenoWorkspace } from "./deno_workspace.ts";
import { GitLogOutput, path, semver } from "./deps.ts";

const workspace = await DenoWorkspace.load();
const repo = workspace.repo;
const cliCrate = workspace.getCliCrate();
const originalCliVersion = cliCrate.version;

// update the std version used in the code
console.log("Updating std version...");
await updateStdVersion();

// increment the cli version
if (Deno.args.some((a) => a === "--patch")) {
  await cliCrate.increment("patch");
} else if (Deno.args.some((a) => a === "--minor")) {
  await cliCrate.increment("minor");
} else if (Deno.args.some((a) => a === "--major")) {
  await cliCrate.increment("major");
} else {
  await cliCrate.promptAndIncrement();
}

// increment the dependency crate versions
for (const crate of workspace.getCliDependencyCrates()) {
  await crate.increment("minor");
}

// update the lock file
await workspace.getCliCrate().cargoUpdate("--workspace");

// try to update the Releases.md markdown text
try {
  console.log("Updating Releases.md...");
  await updateReleasesMd();
} catch (err) {
  console.error(err);
  console.error(
    "Updating Releases.md failed. Please manually run " +
      "`git log --oneline VERSION_FROM..VERSION_TO` and " +
      "use the output to update Releases.md",
  );
}

async function updateReleasesMd() {
  const gitLog = await getGitLog();
  const releasesMdFile = workspace.getReleasesMdFile();
  releasesMdFile.updateWithGitLog({
    version: cliCrate.version,
    gitLog,
  });

  await workspace.runFormatter();
}

async function getGitLog() {
  const originalVersion = semver.parse(originalCliVersion)!;
  const originalVersionTag = `v${originalCliVersion}`;
  // fetch the upstream tags
  await repo.gitFetchTags("upstream");

  // make the repo unshallow so we can fetch the latest tag
  if (await repo.gitIsShallow()) {
    await repo.gitFetchUnshallow("origin");
  }

  // this means we're on the patch release
  const latestTag = await repo.gitLatestTag();
  if (latestTag === originalVersionTag) {
    return await repo.getGitLogFromTags(
      "upstream",
      originalVersionTag,
      undefined,
    );
  } else {
    // otherwise, get the history of the last release
    await repo.gitFetchHistory("upstream");
    const lastMinorHistory = await repo.getGitLogFromTags(
      "upstream",
      `v${originalVersion.major}.${originalVersion.minor}.0`,
      originalVersionTag,
    );
    const currentHistory = await repo.getGitLogFromTags(
      "upstream",
      latestTag,
      undefined,
    );
    const lastMinorMessages = new Set(
      lastMinorHistory.lines.map((r) => r.message),
    );
    return new GitLogOutput(
      currentHistory.lines.filter((l) => !lastMinorMessages.has(l.message)),
    );
  }
}

async function updateStdVersion() {
  const newStdVersion = await getLatestStdVersion();
  const compatFilePath = path.join(cliCrate.folderPath, "compat/mod.rs");
  const text = Deno.readTextFileSync(compatFilePath);
  Deno.writeTextFileSync(
    compatFilePath,
    text.replace(/std@[0-9]+\.[0-9]+\.[0-9]+/, `std@${newStdVersion}`),
  );
}

async function getLatestStdVersion() {
  const url =
    "https://raw.githubusercontent.com/denoland/deno_std/main/version.ts";
  const result = await fetch(url);
  const text = await result.text();
  const version = /"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(text);
  if (version == null) {
    throw new Error(`Could not find version in text: ${text}`);
  } else {
    return version[1];
  }
}
