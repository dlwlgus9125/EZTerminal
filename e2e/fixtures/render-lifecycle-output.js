let frame = 0;
setInterval(() => process.stdout.write(`FRAME ${++frame}\r\n`), 100);
