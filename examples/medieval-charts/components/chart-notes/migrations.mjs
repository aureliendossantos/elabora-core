// 2.0.0: the chart with notes is a fork of the built-in « Image interactive » (hotspots, below). Its notes
// become the markers' items (x and y from 0 to 1 instead of %, body as markdown); its ratio goes (the
// picture keeps its own proportions).
export default {
  '2.0.0': ({ notes = [], ratio, ...rest }) => ({
    presentation: 'below',
    ...rest,
    items: notes.map(({ x, y, body, ...note }) => ({ ...note, x: Math.round(x * 10) / 1000, y: Math.round(y * 10) / 1000, markdown: body }))
  })
};
