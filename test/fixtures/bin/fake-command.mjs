const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "args":
    process.stdout.write(JSON.stringify(args));
    break;
  case "inspect":
    process.stdout.write(JSON.stringify({
      cwd: process.cwd(),
      value: process.env.APR_TEST_VALUE
    }));
    break;
  case "io":
    process.stdout.write("standard output");
    process.stderr.write("standard error");
    process.exitCode = 7;
    break;
  case "sleep":
    setInterval(() => undefined, 1000);
    break;
  case "stream":
    process.stdout.write("first\n");
    setTimeout(() => {
      process.stdout.write("second\n");
    }, 10);
    setInterval(() => undefined, 1000);
    break;
  default:
    process.stderr.write(`unknown mode: ${mode ?? ""}`);
    process.exitCode = 2;
}
