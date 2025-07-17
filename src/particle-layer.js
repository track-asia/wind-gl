/*
 * Copyright (c) 2021-2023 WeatherLayers.com
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
import { LineLayer } from "@deck.gl/layers";
import { isWebGL2, Buffer, Transform } from "@luma.gl/core";
import {
  isViewportGlobe,
  getViewportGlobeCenter,
  getViewportGlobeRadius,
  getViewportBounds,
} from "./utils/viewport.js";
import updateTransformVs from "./particle-layer-update-transform.vs.glsl";

const defaultProps = {
  ...LineLayer.defaultProps,

  image: { type: "image", value: null, async: true },
  uRange: { type: "array", value: [-126, 125] }, // [uMin, uMax]
  vRange: { type: "array", value: [-126, 125] }, // [vMin, vMax]

  numParticles: { type: "number", min: 1, max: 1000000, value: 1000 },
  maxAge: { type: "number", min: 1, max: 255, value: 100 },
  speedFactor: { type: "number", min: 0, max: 1000, value: 1 },

  width: { type: "number", value: 1 },
  animate: true,

  colorStops: {
    type: "array",
    value: [
      0.0,
      "#3288bd",
      10,
      "#66c2a5",
      20,
      "#abdda4",
      30,
      "#e6f598",
      40,
      "#fee08b",
      50,
      "#fdae61",
      60,
      "#f46d43",
      100.0,
      "#d53e4f",
    ],
  },

  bounds: { type: "array", value: [-180, -90, 180, 90], compare: true },
  wrapLongitude: true,
};

export default class ParticleLayer extends LineLayer {
  getShaders() {
    return {
      ...super.getShaders(),
      inject: {
        "vs:#decl": `
          varying float drop;
          varying float vSpeed;
          const vec2 DROP_POSITION = vec2(0);
          
          uniform sampler2D bitmapTexture;
          uniform vec2 uRange;
          uniform vec2 vRange;
          uniform vec4 bounds;
          
          vec2 getUV(vec2 pos) {
            return vec2(
              (pos.x - bounds[0]) / (bounds[2] - bounds[0]),
              (pos.y - bounds[3]) / (bounds[1] - bounds[3])
            );
          }
          
          vec2 raster_get_values(vec4 color) {
            float u = mix(uRange.x, uRange.y, color.x);
            float v = mix(vRange.x, vRange.y, color.y);
            return vec2(u, v);
          }
        `,
        "vs:#main-start": `
          drop = float(instanceSourcePositions.xy == DROP_POSITION || instanceTargetPositions.xy == DROP_POSITION);
          
          if (drop < 0.5) {
            vec2 uv = getUV(instanceSourcePositions.xy);
            vec4 bitmapColor = texture2D(bitmapTexture, uv);
            vec2 speed = raster_get_values(bitmapColor);
            
            // Squared magnitude calculation (fastest, 0% error, need to adjust colorStops)
            vSpeed = speed.x * speed.x + speed.y * speed.y;
            
            // Alternative options for different speed/accuracy tradeoffs:
            // vec2 absSpeed = abs(speed);
            // vSpeed = max(absSpeed.x, absSpeed.y) + 0.428 * min(absSpeed.x, absSpeed.y); // Fast approximation (~4% error)
            // vSpeed = sqrt(speed.x * speed.x + speed.y * speed.y); // Original (accurate but slow)
            // vSpeed = abs(speed.x) + abs(speed.y); // Manhattan distance (~30% error, very fast)
          } else {
            vSpeed = 0.0;
          }
        `,
        "fs:#decl": `
          varying float drop;
          varying float vSpeed;
          uniform float colorStops[16]; // 8 stops * 2 (value + color index)
          uniform vec3 colorValues[8];  // RGB values for each color
          
          vec3 getSpeedColor(float speed) {
            // Unrolled loop for better GPU performance (no branching)
            float t;
            
            // Check each stop manually (faster than loop on GPU)
            if (speed <= colorStops[2]) {
              t = (speed - colorStops[0]) / (colorStops[2] - colorStops[0]);
              return mix(colorValues[0], colorValues[1], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[4]) {
              t = (speed - colorStops[2]) / (colorStops[4] - colorStops[2]);
              return mix(colorValues[1], colorValues[2], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[6]) {
              t = (speed - colorStops[4]) / (colorStops[6] - colorStops[4]);
              return mix(colorValues[2], colorValues[3], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[8]) {
              t = (speed - colorStops[6]) / (colorStops[8] - colorStops[6]);
              return mix(colorValues[3], colorValues[4], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[10]) {
              t = (speed - colorStops[8]) / (colorStops[10] - colorStops[8]);
              return mix(colorValues[4], colorValues[5], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[12]) {
              t = (speed - colorStops[10]) / (colorStops[12] - colorStops[10]);
              return mix(colorValues[5], colorValues[6], clamp(t, 0.0, 1.0));
            }
            if (speed <= colorStops[14]) {
              t = (speed - colorStops[12]) / (colorStops[14] - colorStops[12]);
              return mix(colorValues[6], colorValues[7], clamp(t, 0.0, 1.0));
            }
            
            return colorValues[7]; // Return last color if speed exceeds all stops
          }
        `,
        "fs:#main-start": `
          if (drop > 0.5) discard;
        `,
        "fs:DECKGL_FILTER_COLOR": `
          vec3 speedColor = getSpeedColor(vSpeed);
          color = vec4(speedColor, color.a);
        `,
      },
    };
  }

  initializeState() {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      throw new Error("WebGL 2 is required");
    }

    super.initializeState({});

    this._setupTransformFeedback();

    const attributeManager = this.getAttributeManager();
    attributeManager.remove([
      "instanceSourcePositions",
      "instanceTargetPositions",
      "instanceColors",
      "instanceWidths",
    ]);
  }

  updateState({ props, oldProps, changeFlags }) {
    const { numParticles, maxAge, width, colorStops } = props;

    super.updateState({ props, oldProps, changeFlags });

    if (!numParticles || !maxAge || !width) {
      this._deleteTransformFeedback();
      return;
    }

    if (
      numParticles !== oldProps.numParticles ||
      maxAge !== oldProps.maxAge ||
      width !== oldProps.width ||
      JSON.stringify(colorStops) !== JSON.stringify(oldProps.colorStops)
    ) {
      this._setupTransformFeedback();
    }
  }

  finalizeState() {
    this._deleteTransformFeedback();

    super.finalizeState();
  }

  draw({ uniforms }) {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      return;
    }

    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { animate, colorStops, image, uRange, vRange, bounds } = this.props;
    const {
      sourcePositions,
      targetPositions,
      sourcePositions64Low,
      targetPositions64Low,
      colors,
      widths,
      model,
      cachedColorStops,
      cachedColorStopsArray,
      cachedColorValuesArray,
    } = this.state;

    model.setAttributes({
      instanceSourcePositions: sourcePositions,
      instanceTargetPositions: targetPositions,
      instanceSourcePositions64Low: sourcePositions64Low,
      instanceTargetPositions64Low: targetPositions64Low,
      instanceColors: colors,
      instanceWidths: widths,
    });

    // Cache colorStops parsing to avoid recalculation every frame
    let colorStopsArray, colorValuesArray;
    if (cachedColorStops !== colorStops) {
      const parsed = this._parseColorStops(colorStops);
      colorStopsArray = parsed.colorStopsArray;
      colorValuesArray = parsed.colorValuesArray;
      
      // Cache the results
      this.setState({
        cachedColorStops: colorStops,
        cachedColorStopsArray: colorStopsArray,
        cachedColorValuesArray: colorValuesArray,
      });
    } else {
      colorStopsArray = cachedColorStopsArray;
      colorValuesArray = cachedColorValuesArray;
    }

    super.draw({
      uniforms: {
        ...uniforms,
        bitmapTexture: image,
        uRange,
        vRange,
        bounds,
        colorStops: colorStopsArray,
        colorValues: colorValuesArray,
      },
    });

    if (animate) {
      this.requestStep();
    }
  }

  _parseColorStops(colorStops) {
    const colorStopsArray = new Array(16).fill(0); // 8 stops * 2
    const colorValuesArray = new Array(24).fill(0); // 8 colors * 3 (RGB)

    for (let i = 0; i < colorStops.length; i += 2) {
      const stopIndex = i / 2;
      if (stopIndex >= 8) break;

      const speed = colorStops[i];
      const colorHex = colorStops[i + 1];

      // Parse hex color to RGB
      const rgb = this._hexToRgb(colorHex);

      // Auto-square the speed values since we're using squared magnitude in shader
      colorStopsArray[stopIndex * 2] = speed * speed;
      colorValuesArray[stopIndex * 3] = rgb.r / 255;
      colorValuesArray[stopIndex * 3 + 1] = rgb.g / 255;
      colorValuesArray[stopIndex * 3 + 2] = rgb.b / 255;
    }

    return { colorStopsArray, colorValuesArray };
  }

  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  }

  _setupTransformFeedback() {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      return;
    }

    const { initialized } = this.state;
    if (initialized) {
      this._deleteTransformFeedback();
    }

    const { numParticles, maxAge, width } = this.props;

    // sourcePositions/targetPositions buffer layout:
    // |          age0         |          age1         |          age2         |...|          ageN         |
    // |pos1,pos2,pos3,...,posN|pos1,pos2,pos3,...,posN|pos1,pos2,pos3,...,posN|...|pos1,pos2,pos3,...,posN|
    const numInstances = numParticles * maxAge;
    const numAgedInstances = numParticles * (maxAge - 1);
    const sourcePositions = new Buffer(gl, new Float32Array(numInstances * 3));
    const targetPositions = new Buffer(gl, new Float32Array(numInstances * 3));
    const sourcePositions64Low = new Float32Array([0, 0, 0]); // constant attribute
    const targetPositions64Low = new Float32Array([0, 0, 0]); // constant attribute
    const colors = new Buffer(
      gl,
      new Float32Array(
        new Array(numInstances)
          .fill(undefined)
          .map((_, i) => {
            const age = Math.floor(i / numParticles);
            return [
              255, // white default
              255,
              255,
              255 * (1 - age / maxAge),
            ].map((d) => d / 255);
          })
          .flat()
      )
    );
    const widths = new Float32Array([width]); // constant attribute

    const transform = new Transform(gl, {
      sourceBuffers: {
        sourcePosition: sourcePositions,
      },
      feedbackBuffers: {
        targetPosition: targetPositions,
      },
      feedbackMap: {
        sourcePosition: "targetPosition",
      },
      vs: updateTransformVs,
      elementCount: numParticles,
    });

    this.setState({
      initialized: true,
      numInstances,
      numAgedInstances,
      sourcePositions,
      targetPositions,
      sourcePositions64Low,
      targetPositions64Low,
      colors,
      widths,
      transform,
    });
  }

  _runTransformFeedback() {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      return;
    }

    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { viewport, timeline } = this.context;
    const { image, uRange, vRange, bounds, numParticles, speedFactor, maxAge } =
      this.props;
    const { numAgedInstances, transform, previousViewportZoom, previousTime } =
      this.state;
    const time = timeline.getTime();
    if (!image || time === previousTime) {
      return;
    }

    // viewport
    const viewportGlobe = isViewportGlobe(viewport);
    const viewportGlobeCenter = getViewportGlobeCenter(viewport);
    const viewportGlobeRadius = getViewportGlobeRadius(viewport);
    const viewportBounds = getViewportBounds(viewport);
    const viewportZoomChangeFactor =
      2 ** ((previousViewportZoom - viewport.zoom) * 4);

    // speed factor for current zoom level
    const currentSpeedFactor = speedFactor / 2 ** (viewport.zoom + 7);

    // update particles age0
    const uniforms = {
      viewportGlobe,
      viewportGlobeCenter: viewportGlobeCenter || [0, 0],
      viewportGlobeRadius: viewportGlobeRadius || 0,
      viewportBounds: viewportBounds || [0, 0, 0, 0],
      viewportZoomChangeFactor: viewportZoomChangeFactor || 0,

      bitmapTexture: image,
      uRange: uRange,
      vRange: vRange,
      bounds,
      numParticles,
      maxAge,
      speedFactor: currentSpeedFactor,

      time,
      seed: Math.random(),
    };
    transform.run({ uniforms });

    // update particles age1-age(N-1)
    // copy age0-age(N-2) sourcePositions to age1-age(N-1) targetPositions
    const sourcePositions =
      transform.bufferTransform.bindings[transform.bufferTransform.currentIndex]
        .sourceBuffers.sourcePosition;
    const targetPositions =
      transform.bufferTransform.bindings[transform.bufferTransform.currentIndex]
        .feedbackBuffers.targetPosition;
    sourcePositions.copyData({
      sourceBuffer: targetPositions,
      readOffset: 0,
      writeOffset: numParticles * 4 * 3,
      size: numAgedInstances * 4 * 3,
    });

    transform.swap();

    // const {sourcePositions, targetPositions} = this.state;
    // console.log(uniforms, sourcePositions.getData().slice(0, 6), targetPositions.getData().slice(0, 6));

    this.state.previousViewportZoom = viewport.zoom;
    this.state.previousTime = time;
  }

  _resetTransformFeedback() {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      return;
    }

    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { numInstances, sourcePositions, targetPositions } = this.state;

    sourcePositions.subData({ data: new Float32Array(numInstances * 3) });
    targetPositions.subData({ data: new Float32Array(numInstances * 3) });
  }

  _deleteTransformFeedback() {
    const { gl } = this.context;
    if (!isWebGL2(gl)) {
      return;
    }

    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { sourcePositions, targetPositions, colors, transform } = this.state;

    sourcePositions.delete();
    targetPositions.delete();
    colors.delete();
    transform.delete();

    this.setState({
      initialized: false,
      sourcePositions: undefined,
      targetPositions: undefined,
      sourcePositions64Low: undefined,
      targetPositions64Low: undefined,
      colors: undefined,
      widths: undefined,
      transform: undefined,
    });
  }

  requestStep() {
    const { stepRequested } = this.state;
    if (stepRequested) {
      return;
    }

    this.state.stepRequested = true;
    
    // Use requestAnimationFrame for better performance and smoother animation
    requestAnimationFrame(() => {
      this.step();
      this.state.stepRequested = false;
    });
  }

  step() {
    this._runTransformFeedback();

    this.setNeedsRedraw();
  }

  clear() {
    this._resetTransformFeedback();

    this.setNeedsRedraw();
  }
}

ParticleLayer.layerName = "ParticleLayer";
ParticleLayer.defaultProps = defaultProps;
