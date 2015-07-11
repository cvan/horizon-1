import React from '../../../../node_modules/react';
import Matrix from './../lib/matrix.js';
import vec4 from '../../../../node_modules/gl-vec4';

var matrix = new Matrix();

const hmdScale = -100;
const pixelsPerMeter = 96 / 2.54;
const formSubmitThreshold = 1500;  // Time to wait for mousedown (buttondown) before triggering a form submit.

export default class Cursor extends React.Component {
  constructor(props) {
    super(props);

    // use CSS variable for mono content scale value.
    this.monoScale = window.getComputedStyle(document.documentElement).getPropertyValue('--content-scale');

    props.runtime.keyboardInput.assign({
      'c.down': () => this.allowCursor().then(this.cursorMouseDown.bind(this)),
      'c.up': () => this.allowCursor().then(this.cursorMouseUp.bind(this))
    });
    this.runtime = props.runtime;

    this.cursorElement = null;
    this.cursorMouseLeaveQueue = [];
  }

  get cursor() {
    return React.findDOMNode(this.refs.cursor);
  }

  /**
   * Allow cursor to be active only when HUD is visible or displaying mono content.
   *
   * @returns {Promise} Resolve if cursor can be active.
   */
  allowCursor() {
    if (this.props.hudVisible || !this.props.activeFrameProps.viewmode === 'stereo') {
      return Promise.resolve();
    } else {
      return Promise.reject();
    }
  }

  /**
   * Traverse up tree to find containing element with matrix3d transform.
   *
   * @param {Element} el Element
   * @returns {Array} Array of matrix3d values.
   */
  getNearest3dTransform(el) {
    if (!el) {
      return false;
    }
    let transform = window.getComputedStyle(el).transform;
    if (transform.indexOf('matrix3d') === -1) {
      return this.getNearest3dTransform(el.parentElement);
    } else {
      return transform;
    }
  }

  /**
   * Return position offset from VR headset.
   *
   * @returns {Object} Position
   * @returns { {x:Number, y:Number, z:Number} } Position
   */
  getPosition() {
    let hmd = this.runtime.hmdState;
    if (!hmd) {
      return false;
    }

    let scale = pixelsPerMeter * hmdScale;
    if (hmd.position) {
      return {
        x: -hmd.position.x * scale,
        y: -hmd.position.y * scale,
        z: -hmd.position.z * scale
      };
    } else {
      return {x: 0, y: 0, z: 0};
    }
  }

  /**
   * Return 3d translation of element.
   *
   * @param {Element} el Element
   * @returns { {x:Number, y:Number, z:Number} } Translation
   */
  getElementTranslation(el) {
    if (!el) {
      return false;
    }

    let transform = this.getNearest3dTransform(el);
    if (!transform) {
      return false;
    }

    let cssMatrix = matrix.matrixFromCss(transform);
    return {
      x: -(cssMatrix[12] * this.monoScale), // multiply by mono container scale
      y: cssMatrix[13] * this.monoScale,
      z: -cssMatrix[14]
    };
  }

  /**
   * Return direction from VR headset quaternion.   Use -Z as forward.
   *
   * @returns {Object} Direction
   * @returns { {x:Number, y:Number, z:Number} } Direction
   */
  getDirection() {
    let hmd = this.runtime.hmdState;
    if (!hmd || !hmd.orientation) {
      return false;
    }

    // Transform the HMD quaternion by direction vector.
    let direction = vec4.transformQuat([], [0, 0, -1, 0],
      [hmd.orientation.x, hmd.orientation.y, hmd.orientation.z, hmd.orientation.w]);

    return {
      x: -direction[0],
      y: -direction[1],
      z: direction[2]
    };
  }

  /**
   * Position the cursor at the same depth as the mono iframe container.
   * Otherwise, use the depth set on cursor element.
   */
  positionCursor() {
    let translation = this.cursorElementTranslation;
    let direction = this.getDirection();
    let position = this.getPosition();

    if (translation && direction && position) {
      // Find intersection on plane.
      let distance = translation.z + position.z;
      let intersectionX = distance / direction.z * direction.x + position.x + translation.x;
      let intersectionY = -(distance / direction.z * direction.y + position.y + translation.y);
      // Use pythagoras to find depth at intersection.
      let intersectionZx = Math.sqrt(Math.pow(distance / direction.z * direction.x, 2) + Math.pow(distance, 2));
      let intersectionZy = Math.sqrt(Math.pow(distance / direction.z * direction.y, 2) + Math.pow(distance, 2));
      let intersectionZ = Math.max(intersectionZx, intersectionZy) - 10; // bias cursor depth to avoid z-fighting.
      this.intersectionX = intersectionX;
      this.intersectionY = intersectionY;

      this.cursor.classList.add('is-visible');
      this.cursor.style.transform = `translate3d(0, 0, -${intersectionZ}px)`;
    } else {
      this.cursor.classList.remove('is-visible');
      this.cursor.style.transform = '';
    }

    requestAnimationFrame(this.positionCursor.bind(this));
  }

  mouseIntoIframe(eventName) {
    var contentContainer = $('#content-container');
    if (this.cursorElement !== contentContainer) {
      return;
    }
    this.frameCommunicator.send('mouse.' + eventName, {
      top: this.intersectionY / this.monoScale,
      left: this.intersectionX / this.monoScale
    });
  }

  cursorMouseUp() {
    let el = this.cursorElement;

    if (el) {
      this.cursorDownElement = null;

      this.runtime.utils.emitMouseEvent('mouseup', el);
      this.runtime.utils.emitMouseEvent('click', el);

      this.mouseIntoIframe('mouseup');
    }

    return Promise.resolve();
  }

  intersectCursor() {
    setTimeout(() => {
      var el = document.elementFromPoint(0, 0);
      if (el !== this.cursorElement || this.cursorElement.transitioned) {
        this.cursorMouseLeave(el);
        this.cursorElement = el;

        // flag elements to have translations re-computed on animation and transition events.
        if (!this.cursorElement.transitioned) {
          this.cursorElement.addEventListener('transitionend', this.handleCursorTransition.bind(this));
          this.cursorElement.addEventListener('animationend', this.handleCursorTransition.bind(this));
        } else {
          this.cursorElement.removeEventListener('transitionend', this.handleCursorTransition.bind(this));
          this.cursorElement.removeEventListener('animationend', this.handleCursorTransition.bind(this));
          delete this.cursorElement.transitioned;
        }

        this.cursorElementTranslation = this.getElementTranslation(el);
        this.cursorMouseEnter();
      }

      requestAnimationFrame(this.intersectCursor.bind(this));
    }, 100); // Checking for element at every RAF is unecessary, so we set a interval at a much lower frequency.
  }

  cursorMouseLeave(newEl) {
    let prevEl = this.cursorElement;

    if (prevEl) {
      prevEl.mock = true;

      this.cursorDownElement = null;

      // Mark a leave only if `previousEl` isn't a child of `el`.
      if (prevEl.contains(newEl)) {
        // The new element is still a parent of the new element, so emit the 'mouseleave' event later.
        this.cursorMouseLeaveQueue.push(prevEl);
      } else {
        // Clear the queue of elements we are no longer focussed on.
        while (this.cursorMouseLeaveQueue.length) {
          this.runtime.utils.emitMouseEvent('mouseleave', this.cursorMouseLeaveQueue.pop());
        }

        this.runtime.utils.emitMouseEvent('mouseleave', prevEl);
      }
    }

    return Promise.resolve();
  }

  handleCursorTransition() {
    this.cursorElement.transitioned = true;
  }

  cursorMouseEnter() {
    let el = this.cursorElement;

    if (el) {
      el.mock = true;

      this.runtime.utils.emitMouseEvent('mouseenter', el);
    }

    return Promise.resolve();
  }

  cursorMouseDown() {
    let el = this.cursorElement;

    if (el) {
      this.cursorDownElement = el;

      el.mock = true;
      this.runtime.utils.emitMouseEvent('mousedown', el);
      if (document.activeElement) {
        document.activeElement.blur();
      }
      el.focus();

      this.mouseIntoIframe('mousedown');

      this.runtime.utils.sleep(formSubmitThreshold).then(() => {
        // If the click button has been depressed for a long time, assume a form submission.
        if (el === this.cursorDownElement) {
          // Check if the active element is in a form element.
          let form = this.runtime.utils.getFocusedForm(el);
          if (form) {
            // If so, submit the form.
            form.submit();
            form.dispatchEvent(new Event('submit'));
          }
        }
      });
    }

    return Promise.resolve();
  }

  componentDidMount() {
    requestAnimationFrame(this.intersectCursor.bind(this));
    requestAnimationFrame(this.positionCursor.bind(this));
  }

  render() {
    return <div id='cursor' ref='cursor' className='cursor threed'>
        <div className='cursor-arrow threed'></div>
      </div>;
  }
}
