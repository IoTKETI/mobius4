const logger = require('../logger').child({ module: 'intervalManager' });

class MultiIntervalManager {
    constructor() {
      this.intervals = new Map(); // intervalId -> { controller, callback, delay, isRunning, options }
      this.nextId = 1;
    }

    // create a new interval and start it
    createInterval(callback, delay, options = {}) {
      const intervalId = options.id || `interval_${this.nextId++}`;

      // if the intervalId already exists, stop the existing interval
      if (this.intervals.has(intervalId)) {
        this.stopInterval(intervalId);
      }

      const controller = new AbortController();
      const signal = controller.signal;

      const intervalData = {
        controller,
        signal,
        callback,
        delay,
        isRunning: true,
        startTime: Date.now(),
        options: { ...options }
      };

      this.intervals.set(intervalId, intervalData);

      const executeInterval = () => {
        if (signal.aborted) {
          logger.debug({ intervalId }, 'interval stopped');
          this.intervals.delete(intervalId);
          return;
        }

        try {
          if (options.params && Array.isArray(options.params)) {
            callback(intervalId, ...options.params);
          } else {
            callback(intervalId);
          }
        } catch (error) {
          logger.error({ err: error, intervalId }, 'interval execution error');
        }

        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };

      setTimeout(executeInterval, delay);

      logger.debug({ intervalId, delayMs: delay }, 'interval started');
      return intervalId;
    }

    updateIntervalDelay(intervalId, newDelay) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        logger.warn({ intervalId }, 'interval not found');
        return false;
      }

      if (!intervalData.isRunning) {
        logger.warn({ intervalId }, 'interval is not running');
        return false;
      }

      intervalData.controller.abort();

      const newController = new AbortController();
      const newSignal = newController.signal;

      intervalData.controller = newController;
      intervalData.signal = newSignal;
      intervalData.delay = newDelay;
      intervalData.startTime = Date.now();

      const executeInterval = () => {
        if (newSignal.aborted) {
          logger.debug({ intervalId }, 'interval stopped');
          this.intervals.delete(intervalId);
          return;
        }

        try {
          intervalData.callback(intervalId);
        } catch (error) {
          logger.error({ err: error, intervalId }, 'interval execution error');
        }

        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };

      setTimeout(executeInterval, newDelay);

      logger.debug({ intervalId, newDelayMs: newDelay }, 'interval delay updated');
      return true;
    }

    pauseInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        logger.warn({ intervalId }, 'interval not found');
        return false;
      }

      intervalData.controller.abort();
      intervalData.isRunning = false;
      logger.debug({ intervalId }, 'interval paused');
      return true;
    }

    resumeInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        logger.warn({ intervalId }, 'interval not found');
        return false;
      }

      if (intervalData.isRunning) {
        logger.warn({ intervalId }, 'interval already running');
        return false;
      }

      const newController = new AbortController();
      const newSignal = newController.signal;

      intervalData.controller = newController;
      intervalData.signal = newSignal;
      intervalData.isRunning = true;
      intervalData.startTime = Date.now();

      const executeInterval = () => {
        if (newSignal.aborted) {
          logger.debug({ intervalId }, 'interval stopped');
          this.intervals.delete(intervalId);
          return;
        }

        try {
          intervalData.callback(intervalId);
        } catch (error) {
          logger.error({ err: error, intervalId }, 'interval execution error');
        }

        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };

      setTimeout(executeInterval, intervalData.delay);
      logger.debug({ intervalId, delayMs: intervalData.delay }, 'interval resumed');
      return true;
    }

    stopInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (intervalData) {
        intervalData.controller.abort();
        this.intervals.delete(intervalId);
        logger.debug({ intervalId }, 'interval stopped');
        return true;
      }
      logger.warn({ intervalId }, 'interval not found');
      return false;
    }

    getIntervalInfo(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) return null;

      return {
        id: intervalId,
        isRunning: intervalData.isRunning,
        delay: intervalData.delay,
        startTime: intervalData.startTime,
        duration: Date.now() - intervalData.startTime
      };
    }

    stopAllIntervals() {
      const intervalIds = Array.from(this.intervals.keys());
      intervalIds.forEach(id => this.stopInterval(id));
      logger.info({ count: intervalIds.length }, 'all intervals stopped');
    }

    getActiveIntervals() {
      return Array.from(this.intervals.keys());
    }
  }

  module.exports = MultiIntervalManager;
