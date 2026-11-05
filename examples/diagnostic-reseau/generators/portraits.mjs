// The requester's portrait on the ticket: the character drawing of the dialogue, framed on the face
// it declares (data-portrait), its default expression. Same drawing, so the ticket and the call
// show the same Marc.
export const meta = { description: "Portraits cadrés sur le visage, tirés des personnages du dialogue (pour le ticket)." };

export default async function generate({ read, write }) {
  for (const name of ['marc']) {
    const svg = String(await read(`assets/personnages/${name}.svg`));
    const box = /data-portrait="([\d.\s]+)"/.exec(svg)?.[1];
    if (!box) throw new Error(`${name}.svg has no data-portrait`);
    write(`images/portrait-${name}.svg`, svg.replace(/viewBox="[^"]*"/, `viewBox="${box.trim()}"`));
  }
}
