const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(1);
});
process.stdin.on('end', () => {
  let allowed = false;
  try {
    const event = JSON.parse(input);
    if (event.toolCall?.name === 'view_file') {
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'images.json'), 'utf8'));
      const requested = fs.realpathSync(event.toolCall.args.AbsolutePath);
      allowed = manifest.some(file => fs.realpathSync(file) === requested);
    }
  } catch {}
  process.stdout.write(JSON.stringify({
    decision: allowed ? 'allow' : 'deny',
    reason: allowed ? 'Read the supplied image' : 'Only supplied images may be read; modifications and other tools are disabled',
  }) + '\n');
});
