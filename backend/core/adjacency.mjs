export function linkFlow(flow, source, target) {
  flow.sourceRef = source;
  flow.targetRef = target;

  if (source) {
    source.outgoing ??= [];
    if (!source.outgoing.includes(flow)) source.outgoing.push(flow);
  }
  if (target) {
    target.incoming ??= [];
    if (!target.incoming.includes(flow)) target.incoming.push(flow);
  }
}

export function unlinkFlow(flow) {
  const source = flow.sourceRef;
  const target = flow.targetRef;

  if (source?.outgoing) {
    const index = source.outgoing.indexOf(flow);
    if (index >= 0) source.outgoing.splice(index, 1);
  }
  if (target?.incoming) {
    const index = target.incoming.indexOf(flow);
    if (index >= 0) target.incoming.splice(index, 1);
  }
}

export function retarget(flow, target) {
  const previousTarget = flow.targetRef;
  if (previousTarget?.incoming) {
    const index = previousTarget.incoming.indexOf(flow);
    if (index >= 0) previousTarget.incoming.splice(index, 1);
  }

  flow.targetRef = target;
  target.incoming ??= [];
  if (!target.incoming.includes(flow)) target.incoming.push(flow);
}
