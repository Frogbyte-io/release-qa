// Flips the fuses a security-conscious consumer typically flips in a packaged app, in place.
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
const exe = process.argv[2];
await flipFuses(exe, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});
console.log(JSON.stringify(await getCurrentFuseWire(exe)));
