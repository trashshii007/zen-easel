// Zen Easel — parent side of the capture measurement actor.
//
// Deliberately empty of behaviour. A JSActor pair needs both halves declared, but every
// exchange here is parent-initiated (getActor().sendQuery(...)), so there is nothing for
// the parent to receive. Keeping it inert is the point: the child is the only side that
// touches page content, and it only speaks when spoken to.

export class ZenEaselCaptureParent extends JSWindowActorParent { }
