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
  
      // execute the interval using AbortController
      const executeInterval = () => {
        if (signal.aborted) {
          console.log(`Interval ${intervalId} was stopped.`);
          this.intervals.delete(intervalId);
          return;
        }
  
        try {
          // pass intervalId and any additional parameters from options
          if (options.params && Array.isArray(options.params)) {
            callback(intervalId, ...options.params);
          } else {
            callback(intervalId);
          }
        } catch (error) {
          console.error(`Interval ${intervalId} execution error:`, error);
        }
  
        // schedule the next execution (use the current delay)
        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };
  
      // start the first execution
      setTimeout(executeInterval, delay);
  
      console.log(`Interval ${intervalId} started. (delay: ${delay}ms)`);
      return intervalId;
    }
  
    // update the interval delay (core functionality!)
    updateIntervalDelay(intervalId, newDelay) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        console.warn(`Interval ${intervalId} not found.`);
        return false;
      }
  
      if (!intervalData.isRunning) {
        console.warn(`Interval ${intervalId} is not running.`);
        return false;
      }
  
      // stop the existing interval
      intervalData.controller.abort();
      
      // create a new AbortController
      const newController = new AbortController();
      const newSignal = newController.signal;
      
      // update the data
      intervalData.controller = newController;
      intervalData.signal = newSignal;
      intervalData.delay = newDelay;
      intervalData.startTime = Date.now(); // reset the start time when the delay is changed
  
      // start the new interval
      const executeInterval = () => {
        if (newSignal.aborted) {
          console.log(`Interval ${intervalId} was stopped.`);
          this.intervals.delete(intervalId);
          return;
        }
  
        try {
          intervalData.callback(intervalId);
        } catch (error) {
          console.error(`Interval ${intervalId} execution error:`, error);
        }
  
        // schedule the next execution (use the new delay)
        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };
  
      // start immediately
      setTimeout(executeInterval, newDelay);
  
      console.log(`Interval ${intervalId} delay changed to ${newDelay}ms.`);
      return true;
    }
  
    // pause the interval
    pauseInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        console.warn(`Interval ${intervalId} not found.`);
        return false;
      }
  
      intervalData.controller.abort();
      intervalData.isRunning = false;
      console.log(`Interval ${intervalId} paused.`);
      return true;
    }
  
    // resume the interval (use the original delay)
    resumeInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (!intervalData) {
        console.warn(`Interval ${intervalId} not found.`);
        return false;
      }
  
      if (intervalData.isRunning) {
        console.warn(`Interval ${intervalId} is already running.`);
        return false;
      }
  
      // create a new AbortController
      const newController = new AbortController();
      const newSignal = newController.signal;
      
      intervalData.controller = newController;
      intervalData.signal = newSignal;
      intervalData.isRunning = true;
      intervalData.startTime = Date.now();
  
      // resume the interval
      const executeInterval = () => {
        if (newSignal.aborted) {
          console.log(`Interval ${intervalId} was stopped.`);
          this.intervals.delete(intervalId);
          return;
        }
  
        try {
          intervalData.callback(intervalId);
        } catch (error) {
          console.error(`Interval ${intervalId} execution error:`, error);
        }
  
        if (this.intervals.has(intervalId)) {
          const currentDelay = this.intervals.get(intervalId).delay;
          setTimeout(executeInterval, currentDelay);
        }
      };
  
      setTimeout(executeInterval, intervalData.delay);
      console.log(`Interval ${intervalId} resumed. (delay: ${intervalData.delay}ms)`);
      return true;
    }
  
    // stop a specific interval
    stopInterval(intervalId) {
      const intervalData = this.intervals.get(intervalId);
      if (intervalData) {
        intervalData.controller.abort();
        this.intervals.delete(intervalId);
        console.log(`Interval ${intervalId} stopped.`);
        return true;
      }
      console.warn(`Interval ${intervalId} not found.`);
      return false;
    }
  
    // get the interval information
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
  
    // stop all intervals
    stopAllIntervals() {
      const intervalIds = Array.from(this.intervals.keys());
      intervalIds.forEach(id => this.stopInterval(id));
      console.log(`All intervals (${intervalIds.length} intervals) stopped.`);
    }
  
    // get the list of active intervals
    getActiveIntervals() {
      return Array.from(this.intervals.keys());
    }
  }
  
  module.exports = MultiIntervalManager;