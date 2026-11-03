// Runs an MCP server's entry point as Claude's built-in Node.js does (Claude for desktop's
// mcp-runtime nodeHost.js, its default for an extension whose server is Node): the host's own
// stdin and stdout are not the connection. Its process.stdin and process.stdout are JavaScript
// streams over a message channel (here the IPC channel of the test that started it), so a server
// that hands its handles to a child process (stdio: 'inherit') gives it an empty input and an
// output nobody reads.
'use strict';
const path = require('node:path');
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

const [entry, ...args] = process.argv.slice(2);
const decoder = new StringDecoder('utf8');
process.stdout.write = function (chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  if (text.length > 0) process.send({ type: 'stdout', content: text });
  const done = typeof encoding === 'function' ? encoding : callback;
  if (done) process.nextTick(done);
  return true;
};
const input = new Readable({ read() {} });
for (const name of ['read', 'push', 'unshift', 'pause', 'resume', 'pipe', 'unpipe', 'on', 'once', 'removeListener', 'removeAllListeners', 'setEncoding', 'destroy', 'isPaused']) {
  process.stdin[name] = input[name].bind(input);
}
process.on('message', (message) => {
  if (message.type === 'stdin') input.push(message.data + '\n');
});
process.argv = ['node', entry, ...args];
require(path.resolve(entry));
