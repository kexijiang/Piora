export function createCompanionExpression(random = Math.random) {
  let glanceIn = 3 + random() * 3;
  let glanceTime = 0;
  let glanceX = 0, glanceY = 0;
  const state = { eyesX: 0, eyesY: 0, headX: 0, headY: 0, smile: 0 };
  return (input: {
    delta: number; pointerX: number; pointerY: number; pointerActive: boolean;
    sleeping: boolean; reducedMotion: boolean; friendly: boolean;
  }) => {
    const dt = Math.max(0, Math.min(input.delta, 0.1));
    if (input.reducedMotion) {
      Object.assign(state, { eyesX: 0, eyesY: 0, headX: 0, headY: 0, smile: 0 });
      return state;
    }
    if (!input.sleeping && !input.pointerActive) {
      glanceIn -= dt;
      if (glanceIn <= 0) {
        glanceX = (random() - 0.5) * 0.5;
        glanceY = (random() - 0.5) * 0.16;
        glanceTime = 0.7 + random() * 0.7;
        glanceIn = 3 + random() * 4;
      }
      glanceTime = Math.max(0, glanceTime - dt);
    } else { glanceTime = 0; }
    const x = input.sleeping ? 0 : input.pointerActive ? Math.max(-1, Math.min(1, input.pointerX)) : glanceTime > 0 ? glanceX : 0;
    const y = input.sleeping ? 0 : input.pointerActive ? Math.max(-1, Math.min(1, input.pointerY)) : glanceTime > 0 ? glanceY : 0;
    const eyes = 1 - Math.exp(-14 * dt), head = 1 - Math.exp(-4 * dt);
    state.eyesX += (x - state.eyesX) * eyes;
    state.eyesY += (y - state.eyesY) * eyes;
    state.headX += (x - state.headX) * head;
    state.headY += (y - state.headY) * head;
    const smile = input.friendly && !input.sleeping ? (input.pointerActive ? 0.22 : 0.07) : 0;
    state.smile += (smile - state.smile) * (1 - Math.exp(-3 * dt));
    return state;
  };
}
