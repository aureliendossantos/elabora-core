// 2.0.0: the figure in layers is a fork of the built-in « Étapes » (steps, scroll, figure build). Its base
// and alt become figureImage and figureAlt, its layers the steps' items (each named after its picture,
// to be reworded: a title of a few words and a sentence for text views and exports), decorative since
// the figure's alt describes it whole. A figure without layers keeps its picture as its one step.
const name = (asset) => String(asset).replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
const slug = (asset, i) => name(asset).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || `layer-${i + 1}`;
export default {
  '2.0.0': ({ base, alt, layers = [], ...rest }) => {
    const items = layers.length
      ? layers.map((layer, i) => ({ id: slug(layer.asset, i), title: name(layer.asset), markdown: name(layer.asset), image: layer.asset, decorative: true, ...(layer.reveal ? { reveal: layer.reveal } : {}) }))
      : [{ id: slug(base, 0), title: name(base), markdown: name(base), image: base, alt }];
    return { presentation: 'scroll', figure: 'build', ...(layers.length ? { figureImage: base, figureAlt: alt } : {}), items, ...rest };
  }
};
