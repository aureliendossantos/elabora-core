// 2.0.0: the workshop is a fork of the built-in « Étapes » (steps, scroll, figure build). Its base and
// alt become figureImage and figureAlt, its stages the steps' items (title, markdown, the layer as
// image); the labels keep their stage.
export default {
  '2.0.0': ({ base, alt, stages = [], ...rest }) => ({
    presentation: 'scroll',
    figure: 'build',
    side: 'start',
    figureImage: base,
    figureAlt: alt,
    items: stages.map((stage, i) => ({ id: `stage-${i + 1}`, title: stage.title, markdown: stage.body, image: stage.layer })),
    ...rest
  })
};
