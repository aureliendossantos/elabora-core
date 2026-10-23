// A trend in predict mode (D60): the learner draws the end of the line before seeing it. It keeps the
// learner's guess like a numeric answer (state codec "n") and counts in the score only when scored.

export const isPredict = (type: string | null | undefined, props: Readonly<Record<string, unknown>> | null | undefined): boolean =>
  type === 'trend' && !!props && props.mode === 'predict' && !!props.predict && typeof props.predict === 'object';
