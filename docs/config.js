export function initConfig() {
  return {
    rotate: false,
    particle: {
      numParticles: 1000,
      maxAge: 30,
      speedFactor: 50,
      width: 2,
      opacity: 0.8,
      animate: true,
      colorStops: [
        0.0, "#3288bd",   // blue
        2.0, "#abdda4",    // light green
        5.0, "#fee08b",    // light yellow
        9.0, "#f46d43",    // red orange
        18.0, "#d53e4f",  // red
        30.0, "#C501FD",
      ]
    },
  };
}

export function initGuiSimple(config, update, { globe } = {}) {
  const gui = new dat.GUI();
  gui.width = 300;

  if (globe) {
    gui.add(config, 'rotate').onChange(update);
  }
  
  return gui;
}

export function initGui(config, update, { deckgl, globe } = {}) {
  const gui = initGuiSimple(config, update, { globe });

  const particle = gui.addFolder('ParticleLayer');
  particle.add(config.particle, 'numParticles', 0, 100000, 1).onFinishChange(update);
  particle.add(config.particle, 'maxAge', 1, 255, 1).onFinishChange(update);
  particle.add(config.particle, 'speedFactor', 0.1, 200, 0.1).onChange(update);
  particle.add(config.particle, 'width', 0.5, 5, 0.5).onChange(update);
  particle.add(config.particle, 'opacity', 0, 1, 0.01).onChange(update);
  particle.add(config.particle, 'animate').onChange(update);
  
  particle.add({ step: () => deckgl.props.layers.find(x => x.id === 'particle')?.step() }, 'step');
  particle.add({ clear: () => deckgl.props.layers.find(x => x.id === 'particle')?.clear() }, 'clear');
  particle.open();
}