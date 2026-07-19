// js/core/validation_logger.js — Rehabilitation Pipeline Validation Logger
// System validation metrics — Not clinical outcome.

export const DEBUG_MODE = false;
export const RESEARCH_MODE = false;

export const GAME_EXPECTED_GESTURES = {
    'STACK': ['grasp'],
    'BALLDROP': ['pinch'],
    'FISHHUNT': ['pinch', 'grasp'],
    'SLINGSHOT': ['pinch'],
    'TRACE': ['pinch'],
    'POUR': ['grasp'],
    'DOOR': ['grasp'],
    'FEEDING': ['pinch'],
    'BUBBLEBOUNCE': ['pinch', 'grasp'],
    'WIPE': ['grasp'],
    'WRISTWAVE': ['pinch', 'grasp'],
    'WINDOW': ['pinch', 'grasp']
};

class ValidationLoggerClass {
    constructor() {
        this.sessionId = this.generateSessionId();
        this.eventHistory = [];
        this.researchBuffer = [];
        this.researchInterval = 100; // 10Hz sampling (100ms)
        this._lastResearchSample = 0;
        this._startTime = Date.now();
        this._sessionStarted = false;

        this.currentTaskId = 'GENERAL';
        this.currentTrialId = null;
        this.taskMappingStats = {};

        // Gesture duration tracking
        this.gestureStartTimes = {};
        this.gestureDurations = { pinch: [], grasp: [] };

        // Clinical (debounced) gesture tracking state
        this.clinicalPinchActive = false;
        this.clinicalPinchStartTime = null;
        this.clinicalPinchLastActiveTime = null;
        this.clinicalGraspActive = false;
        this.clinicalGraspStartTime = null;
        this.clinicalGraspLastActiveTime = null;
        this.clinicalGestureDurations = { pinch: [], grasp: [] };
        this.clinicalPinchCount = 0;
        this.clinicalGraspCount = 0;

        // Trace of previous frames for transition logging
        this._prev_x_pinch = 0;
        this._prev_x_grasp = 0;

        // Cumulative Session Statistics
        this.stats = {
            trackingLostEvents: 0,
            trackingRecoveredEvents: 0,
            activeFrames: 0,
            trackedFrames: 0,
            pinchCount: 0,
            graspCount: 0,
            rapidTransitions: 0, // renamed from falseTransitions / unstableTransitions
            completedGames: 0,
            totalGames: 0,
            successRateTotal: 0,
            successRateCount: 0,
            measurements: []
        };

        // Scientific accumulator for session summary statistics
        this._sessionStatsAccumulator = {
            uPinchSum: 0,
            uPinchCount: 0,
            uPinchMax: 0,
            uGraspSum: 0,
            uGraspCount: 0,
            uGraspMax: 0,
            pinchIntentDuration: 0,
            graspIntentDuration: 0,
            acceptedActions: 0,
            rejectedActions: 0
        };

        // Backward compatibility mappings
        Object.defineProperty(this.stats, 'falseTransitions', {
            get: () => this.stats.rapidTransitions,
            set: (val) => { this.stats.rapidTransitions = val; }
        });
        Object.defineProperty(this.stats, 'unstableTransitions', {
            get: () => this.stats.rapidTransitions,
            set: (val) => { this.stats.rapidTransitions = val; }
        });
        Object.defineProperty(this.stats, 'trackingLosses', {
            get: () => this.stats.trackingLostEvents,
            set: (val) => { this.stats.trackingLostEvents = val; }
        });

        // Cache previous state values to detect transition events safely
        this.lastHandTrackingState = null;
        this.lastHandPose = 'neutral';
        this.lastHandSide = 'RIGHT';
        this._lastTransitionTime = null;
    }

    generateSessionId() {
        let uuid = "";
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            try {
                uuid = crypto.randomUUID();
            } catch (e) {
                // Ignore fallback
            }
        }
        if (!uuid) {
            const ts = Date.now();
            const rand = Math.floor(Math.random() * 1000000);
            uuid = `${ts}_${rand}`;
        }
        return "S_" + uuid;
    }

    getMetadata() {
        let browser = 'Unknown';
        let platform = 'Unknown';
        let device = 'Desktop';
        if (typeof navigator !== 'undefined') {
            browser = navigator.userAgent || 'Unknown';
            platform = navigator.platform || 'Unknown';
            if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
                device = 'Mobile';
            }
        }
        
        let cameraResolution = "640x480";
        if (typeof document !== 'undefined') {
            const video = document.querySelector('video');
            if (video && video.videoWidth) {
                cameraResolution = `${video.videoWidth}x${video.videoHeight}`;
            }
        }

        const mediaPipeVersion = (typeof window !== 'undefined' && (window.mpHands?.VERSION || window.Hands?.VERSION)) || "0.10.0";

        return {
            loggerVersion: "1.2.0",
            appVersion: "1.0.0",
            algorithmVersion: "1.0.0",
            sessionId: this.sessionId,
            browser,
            platform,
            device,
            mediaPipeVersion,
            cameraResolution,
            sourceFPS: (typeof window !== 'undefined' && window.engine?.fps) || 30
        };
    }

    startSession(taskId) {
        this._sessionStarted = true;
        this._startTime = Date.now();
        this.sessionId = this.generateSessionId();
        this.currentTaskId = taskId || 'GENERAL';
        this.currentTrialId = null;
        this.taskMappingStats = {};
        
        this.gestureStartTimes = {};
        this.gestureDurations = { pinch: [], grasp: [] };

        // Clinical (debounced) gesture tracking state
        this.clinicalPinchActive = false;
        this.clinicalPinchStartTime = null;
        this.clinicalPinchLastActiveTime = null;
        this.clinicalGraspActive = false;
        this.clinicalGraspStartTime = null;
        this.clinicalGraspLastActiveTime = null;
        this.clinicalGestureDurations = { pinch: [], grasp: [] };
        this.clinicalPinchCount = 0;
        this.clinicalGraspCount = 0;

        const totalGamesFromEngine = (typeof window !== 'undefined' && window.engine?.state?.sessionPlan?.length) || 0;

        this.stats = {
            trackingLostEvents: 0,
            trackingRecoveredEvents: 0,
            activeFrames: 0,
            trackedFrames: 0,
            pinchCount: 0,
            graspCount: 0,
            rapidTransitions: 0,
            completedGames: 0,
            totalGames: totalGamesFromEngine,
            successRateTotal: 0,
            successRateCount: 0,
            measurements: []
        };

        // Reset scientific accumulator for session summary statistics
        this._sessionStatsAccumulator = {
            uPinchSum: 0,
            uPinchCount: 0,
            uPinchMax: 0,
            uGraspSum: 0,
            uGraspCount: 0,
            uGraspMax: 0,
            pinchIntentDuration: 0,
            graspIntentDuration: 0,
            acceptedActions: 0,
            rejectedActions: 0
        };

        // Redefine backward compatibility properties on the new stats object
        Object.defineProperty(this.stats, 'falseTransitions', {
            get: () => this.stats.rapidTransitions,
            set: (val) => { this.stats.rapidTransitions = val; }
        });
        Object.defineProperty(this.stats, 'unstableTransitions', {
            get: () => this.stats.rapidTransitions,
            set: (val) => { this.stats.rapidTransitions = val; }
        });
        Object.defineProperty(this.stats, 'trackingLosses', {
            get: () => this.stats.trackingLostEvents,
            set: (val) => { this.stats.trackingLostEvents = val; }
        });

        this.eventHistory = [];
        this.researchBuffer = [];

        this.lastHandTrackingState = null;
        this.lastHandPose = 'neutral';
        this.lastHandSide = 'RIGHT';
        this._lastTransitionTime = null;

        this.logEvent({
            event: 'SESSION_STARTED',
            taskId: this.currentTaskId,
            message: 'Validation session initialized.'
        });
    }

    setTask(taskId) {
        this.currentTaskId = taskId || 'GENERAL';
    }

    setTrial(trialId) {
        this.currentTrialId = trialId !== undefined ? trialId : null;
    }

    getTimestamp() {
        const diff = Date.now() - this._startTime;
        const totalSecs = diff / 1000;
        const mins = Math.floor(totalSecs / 60);
        const secs = Math.floor(totalSecs % 60);
        const ms = Math.floor(diff % 1000);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    getEAMDRSnapshot(hand) {
        if (!hand) return null;
        
        // Try to read from hand.debug if available
        if (hand.debug) {
            return {
                layer1_observation: {
                    tracking: hand.debug.layer1?.tracking ?? true,
                    confidence: hand.debug.layer1?.confidence ?? hand.confidence ?? 1.0,
                    scale: hand.debug.layer1?.scale ?? hand.scale ?? 1.0,
                    thumbIndexDistance: hand.debug.layer1?.thumbIndexDistance ?? hand.pinchDist ?? 0,
                    thumbPalmDistance: hand.debug.layer1?.thumbPalmDistance ?? hand.thumbToPalm ?? 0,
                    curledCount: hand.debug.layer1?.curledCount ?? 0,
                    fingerClosure: hand.debug.layer1?.fingerClosure ?? 0
                },
                layer2_representation: {
                    u_pinch: hand.debug.layer2?.u_pinch ?? hand.u_pinch ?? 0,
                    u_grasp: hand.debug.layer2?.u_grasp ?? hand.u_grasp ?? 0,
                    pinchProgress: hand.debug.layer2?.pinchProgress ?? hand.pinchProgress ?? 0,
                    graspProgress: hand.debug.layer2?.graspProgress ?? hand.graspProgress ?? 0,
                    thumbProgress: hand.debug.layer2?.thumbProgress ?? hand.thumbProgress ?? 0
                },
                layer3_equilibrium: {
                    baselinePinch: hand.debug.layer3?.baselinePinch ?? hand.equilibrium?.pinch ?? 0.10,
                    baselineGrasp: hand.debug.layer3?.baselineGrasp ?? hand.equilibrium?.grasp ?? 0.15,
                    sigmaPinch: hand.debug.layer3?.sigmaPinch ?? hand.sigmaPinch ?? 0.02,
                    sigmaGrasp: hand.debug.layer3?.sigmaGrasp ?? hand.sigmaGrasp ?? 0.02,
                    stableCount: hand.debug.layer3?.stableCount ?? hand.equilibrium?.stableCount ?? 0,
                    isQuiescent: hand.debug.layer3?.isQuiescent ?? hand.isQuiescent ?? false,
                    rawPinchDelta: hand.debug.layer3?.rawPinchDelta ?? 0,
                    rawGraspDelta: hand.debug.layer3?.rawGraspDelta ?? 0
                },
                layer4_deviation: {
                    x_pinch: hand.debug.layer4?.x_pinch ?? hand.x_pinch ?? 0,
                    x_grasp: hand.debug.layer4?.x_grasp ?? hand.x_grasp ?? 0,
                    flexionAxis: hand.debug.layer4?.flexionAxis ?? hand.flexionAxis ?? 0,
                    extensionAxis: hand.debug.layer4?.extensionAxis ?? hand.extensionAxis ?? 0,
                    relaxationAxis: hand.debug.layer4?.relaxationAxis ?? hand.relaxationAxis ?? 0,
                    vectorMagnitude: hand.debug.layer4?.vectorMagnitude ?? hand.motorState?.magnitude ?? 0,
                    direction: hand.debug.layer4?.direction ?? hand.motorState?.direction ?? 0
                },
                layer5_motor_state: {
                    x: hand.debug.layer5?.x ?? hand.motorState?.x ?? 0,
                    y: hand.debug.layer5?.y ?? hand.motorState?.y ?? 0,
                    magnitude: hand.debug.layer5?.magnitude ?? hand.motorState?.magnitude ?? 0,
                    direction: hand.debug.layer5?.direction ?? hand.motorState?.direction ?? 0,
                    activation: hand.debug.layer5?.activation ?? hand.motorState?.activation ?? 0,
                    neutralProbability: hand.debug.layer5?.neutralProbability ?? hand.motorState?.neutralProbability ?? 0,
                    intent: hand.debug.layer5?.intent ?? hand.motorState?.intent ?? 'neutral'
                },
                layer6_mapping: {
                    candidatePinch: hand.debug.layer6?.candidatePinch ?? false,
                    candidateGrasp: hand.debug.layer6?.candidateGrasp ?? false,
                    pinchActive: hand.debug.layer6?.pinchActive ?? hand.pinch ?? false,
                    graspActive: hand.debug.layer6?.graspActive ?? hand.grasp ?? false,
                    activation: hand.debug.layer6?.activation ?? hand.motorState?.activation ?? 0,
                    thresholds: hand.debug.layer6?.thresholds ?? {
                        pinchGrab: 1.2,
                        pinchRelease: 0.8,
                        graspGrab: 1.2,
                        graspRelease: 0.8
                    }
                }
            };
        }

        // Fallback if hand.debug is not present
        return {
            layer1_observation: {
                tracking: true,
                confidence: hand.confidence ?? 1.0,
                scale: hand.scale ?? 1.0,
                thumbIndexDistance: hand.pinchDist ?? 0,
                thumbPalmDistance: hand.thumbToPalm ?? 0,
                curledCount: 0,
                fingerClosure: 0
            },
            layer2_representation: {
                u_pinch: hand.u_pinch ?? 0,
                u_grasp: hand.u_grasp ?? 0,
                pinchProgress: hand.pinchProgress ?? 0,
                graspProgress: hand.graspProgress ?? 0,
                thumbProgress: hand.thumbProgress ?? 0
            },
            layer3_equilibrium: {
                baselinePinch: hand.equilibrium?.pinch ?? 0.10,
                baselineGrasp: hand.equilibrium?.grasp ?? 0.15,
                sigmaPinch: hand.sigmaPinch ?? 0.02,
                sigmaGrasp: hand.sigmaGrasp ?? 0.02,
                stableCount: hand.equilibrium?.stableCount ?? 0,
                isQuiescent: hand.isQuiescent ?? false,
                rawPinchDelta: 0,
                rawGraspDelta: 0
            },
            layer4_deviation: {
                x_pinch: hand.x_pinch ?? 0,
                x_grasp: hand.x_grasp ?? 0,
                flexionAxis: hand.flexionAxis ?? 0,
                extensionAxis: hand.extensionAxis ?? 0,
                relaxationAxis: hand.relaxationAxis ?? 0,
                vectorMagnitude: hand.motorState?.magnitude ?? 0,
                direction: hand.motorState?.direction ?? 0
            },
            layer5_motor_state: {
                x: hand.motorState?.x ?? 0,
                y: hand.motorState?.y ?? 0,
                magnitude: hand.motorState?.magnitude ?? 0,
                direction: hand.motorState?.direction ?? 0,
                activation: hand.motorState?.activation ?? 0,
                neutralProbability: hand.motorState?.neutralProbability ?? 0,
                intent: hand.motorState?.intent ?? 'neutral'
            },
            layer6_mapping: {
                candidatePinch: false,
                candidateGrasp: false,
                pinchActive: hand.pinch ?? false,
                graspActive: hand.grasp ?? false,
                activation: hand.motorState?.activation ?? 0,
                thresholds: {
                    pinchGrab: 1.2,
                    pinchRelease: 0.8,
                    graspGrab: 1.2,
                    graspRelease: 0.8
                }
            }
        };
    }

    getScientificEventName(event, payload) {
        // Direct matches or mapping to the 14 standard events
        const direct = {
            'SESSION_START': 'SESSION_STARTED',
            'SESSION_STARTED': 'SESSION_STARTED',
            'SESSION_END': 'SESSION_FINISHED',
            'SESSION_FINISHED': 'SESSION_FINISHED',
            'TRACKING_ACQUIRED': 'TRACKING_STARTED',
            'TRACKING_STARTED': 'TRACKING_STARTED',
            'TRACKING_LOST': 'TRACKING_LOST',
            'TRACKING_RECOVERED': 'TRACKING_RECOVERED',
            'PINCH_BEGIN': 'PINCH_INTENT_STARTED',
            'PINCH_INTENT_STARTED': 'PINCH_INTENT_STARTED',
            'PINCH_END': 'PINCH_INTENT_ENDED',
            'PINCH_INTENT_ENDED': 'PINCH_INTENT_ENDED',
            'GRASP_BEGIN': 'GRASP_INTENT_STARTED',
            'GRASP_INTENT_STARTED': 'GRASP_INTENT_STARTED',
            'GRASP_END': 'GRASP_INTENT_ENDED',
            'GRASP_INTENT_ENDED': 'GRASP_INTENT_ENDED',
            'TASK_SUCCESS': 'TASK_COMPLETED',
            'TASK_COMPLETED': 'TASK_COMPLETED',
            'TASK_FAILED': 'TASK_FAILED'
        };

        if (direct[event]) {
            return direct[event];
        }

        // Context Mapping
        if (event === 'ACTION_EXECUTED') {
            return payload.status === 'ACCEPTED' ? 'CONTEXT_ACCEPTED' : 'CONTEXT_REJECTED';
        }

        // Game Interactions
        const pickedEvents = ['BALL_GRAB', 'OBJECT_GRAB', 'BLOCK_GRAB', 'DOOR_GRAB', 'BOTTLE_GRAB', 'POUR_START', 'GRAB_OBJECT', 'HIT', 'BALL_PICKUP', 'OBJECT_PICKED'];
        if (pickedEvents.includes(event)) {
            return 'OBJECT_PICKED';
        }

        const releasedEvents = ['BALL_RELEASE', 'OBJECT_RELEASE', 'BLOCK_RELEASE', 'DOOR_RELEASE', 'BOTTLE_RELEASE', 'POUR_END', 'RELEASE_OBJECT', 'OBJECT_RELEASED'];
        if (releasedEvents.includes(event)) {
            return 'OBJECT_RELEASED';
        }

        const reachedEvents = ['DROP_SUCCESS', 'PLACE_SUCCESS', 'TARGET_HIT', 'POUR_SUCCESS', 'FEED_SUCCESS', 'DOOR_SUCCESS', 'SWIPE_SUCCESS', 'TARGET_REACHED'];
        if (reachedEvents.includes(event)) {
            return 'TARGET_REACHED';
        }

        const failedEvents = ['DROP_FAIL', 'DROP_FAILURE', 'PLACE_FAIL', 'TARGET_MISS', 'POUR_FAIL', 'FEED_FAIL', 'DOOR_FAIL'];
        if (failedEvents.includes(event)) {
            return 'TASK_FAILED';
        }

        return null;
    }

    logEvent({ event, taskId, hand, tracking, message, ...payload }) {
        const timestampStr = this.getTimestamp();
        const timestampSec = (Date.now() - this._startTime) / 1000;

        const activeHandObj = (typeof window !== 'undefined' && window.engine?.state?.input?.hand);
        const defaultHand = (activeHandObj?.side?.toUpperCase()) || 'RIGHT';
        const defaultTracking = typeof window !== 'undefined' && !!activeHandObj?.tracking;

        // Perform event mapping for scientific log
        const scientificEvent = this.getScientificEventName(event, payload);

        // Keep console logging verbose for all events
        let category = 'Game';
        if (['TRACKING_ACQUIRED', 'TRACKING_LOST', 'TRACKING_RECOVERED', 'HAND_SWITCH'].includes(event)) {
            category = 'Tracking';
        } else if (['PINCH_BEGIN', 'PINCH_END', 'GRASP_BEGIN', 'GRASP_END', 'GESTURE_CHANGED', 'RAPID_TRANSITION'].includes(event)) {
            category = 'Gesture';
        }

        console.log(`%c[${category}] %c${timestampStr} %c${event}`, 'color: #2196F3; font-weight: bold;', 'color: #9E9E9E;', 'color: #4CAF50; font-weight: bold;');
        if (message) {
            console.log(`  Message: ${message}`);
        }
        for (const [key, val] of Object.entries(payload)) {
            if (key === 'decision') continue; // Avoid duplicating decision object in logs
            if (typeof val === 'number') {
                console.log(`  ${key}: ${val.toFixed(3)}`);
            } else {
                console.log(`  ${key}: ${JSON.stringify(val)}`);
            }
        }

        // Only log to eventHistory if it's a valid scientific event
        if (scientificEvent) {
            let thresholds = null;
            if (activeHandObj) {
                const h = activeHandObj;
                const pt = h._pinchThresholds || { grab: 1.20, release: 0.75 };
                const gt = h._graspThresholds || { grab: 1.80, release: 1.00 };
                const continuousGraspFactor = h.graspFingerFactor ?? 1.0;
                const modulatedGraspThreshold = gt.grab / (0.4 + 0.6 * continuousGraspFactor);
                thresholds = {
                    pinchGrab: pt.grab,
                    pinchRelease: pt.release,
                    graspGrab: gt.grab,
                    graspRelease: gt.release,
                    modulatedGraspThreshold: modulatedGraspThreshold
                };
            } else {
                thresholds = {
                    pinchGrab: 1.20,
                    pinchRelease: 0.75,
                    graspGrab: 1.80,
                    graspRelease: 1.00,
                    modulatedGraspThreshold: 1.80
                };
            }

            const eventObj = {
                timestamp: parseFloat(timestampSec.toFixed(3)),
                sessionId: this.sessionId,
                taskId: taskId || this.currentTaskId || (typeof window !== 'undefined' && window.engine?.state?.mode) || 'GENERAL',
                event: scientificEvent,
                hand: hand || defaultHand,
                u_pinch: activeHandObj ? parseFloat((activeHandObj.u_pinch ?? activeHandObj.pinchProgress ?? 0).toFixed(4)) : 0,
                u_grasp: activeHandObj ? parseFloat((activeHandObj.u_grasp ?? activeHandObj.graspProgress ?? 0).toFixed(4)) : 0,
                x_pinch: activeHandObj ? parseFloat((activeHandObj.x_pinch ?? 0).toFixed(4)) : 0,
                x_grasp: activeHandObj ? parseFloat((activeHandObj.x_grasp ?? 0).toFixed(4)) : 0,
                activation: activeHandObj ? parseFloat((activeHandObj.motorState?.activation ?? activeHandObj.activation ?? 0).toFixed(4)) : 0,
                intent: activeHandObj ? (activeHandObj.pose ?? activeHandObj.motorState?.intent ?? 'neutral') : 'neutral',
                eadmr: activeHandObj ? {
                    velocity: parseFloat((activeHandObj.filteredVelocity ?? 0).toFixed(4)),
                    instantMotionQuiescent: !!activeHandObj.frameQuiescent,
                    quiescent: !!activeHandObj.isQuiescent,
                    stableFrames: activeHandObj.equilibrium?.stableCount ?? 0,
                    baselineUpdated: !!activeHandObj.baselineUpdated,
                    noiseLevel: {
                        pinch: parseFloat((activeHandObj.sigmaPinch ?? activeHandObj.restingPinchStd ?? 0.02).toFixed(4)),
                        grasp: parseFloat((activeHandObj.sigmaGrasp ?? activeHandObj.restingGraspStd ?? 0.02).toFixed(4))
                    }
                } : null,
                context: {
                    game: taskId || this.currentTaskId || 'GENERAL',
                    expectedGestures: GAME_EXPECTED_GESTURES[taskId || this.currentTaskId || 'GENERAL'] || []
                },
                thresholds: thresholds
            };

            if (payload.success !== undefined) {
                eventObj.success = payload.success;
            } else if (scientificEvent === 'TASK_COMPLETED') {
                eventObj.success = true;
            } else if (scientificEvent === 'TASK_FAILED') {
                eventObj.success = false;
            }

            if (message) {
                eventObj.message = message;
            }

            this.eventHistory.push(eventObj);

            if (this.eventHistory.length > 5000) {
                this.eventHistory.shift();
            }
        }

        // Auto-intercept standard gameplay logs and map to the paper's multi-layer executing taxonomy
        // (Only run this interceptor for non-mapped events to avoid double logging)
        const mappedScientific = this.getScientificEventName(event, payload);
        const alreadyMapped = ['SESSION_STARTED', 'SESSION_FINISHED', 'TRACKING_STARTED', 'TRACKING_LOST', 'TRACKING_RECOVERED', 'PINCH_INTENT_STARTED', 'PINCH_INTENT_ENDED', 'GRASP_INTENT_STARTED', 'GRASP_INTENT_ENDED', 'CONTEXT_ACCEPTED', 'CONTEXT_REJECTED', 'OBJECT_PICKED', 'OBJECT_RELEASED', 'TARGET_REACHED', 'TASK_COMPLETED', 'TASK_FAILED'].includes(mappedScientific);

        if (!alreadyMapped && event) {
            const gameId = (taskId || this.currentTaskId || 'GENERAL').toUpperCase();
            if (['BALL_GRAB', 'OBJECT_GRAB', 'BLOCK_GRAB', 'DOOR_GRAB', 'BOTTLE_GRAB', 'POUR_START', 'GRAB_OBJECT', 'HIT'].includes(event)) {
                this.logActionExecuted({
                    game: gameId,
                    gesture: ['STACK', 'POUR', 'DOOR', 'WIPE'].includes(gameId) ? 'GRASP' : 'PINCH',
                    action: 'GRAB_OBJECT',
                    status: 'ACCEPTED'
                });
            } else if (['BALL_RELEASE', 'OBJECT_RELEASE', 'BLOCK_RELEASE', 'DOOR_RELEASE', 'BOTTLE_RELEASE', 'POUR_END', 'RELEASE_OBJECT'].includes(event)) {
                this.logActionExecuted({
                    game: gameId,
                    gesture: ['STACK', 'POUR', 'DOOR', 'WIPE'].includes(gameId) ? 'GRASP' : 'PINCH',
                    action: 'RELEASE_OBJECT',
                    status: 'ACCEPTED'
                });
            } else if (['DROP_SUCCESS', 'PLACE_SUCCESS', 'TARGET_HIT', 'POUR_SUCCESS', 'FEED_SUCCESS', 'DOOR_SUCCESS', 'SWIPE_SUCCESS'].includes(event)) {
                this.logTaskOutcome({
                    game: gameId,
                    success: true,
                    object: payload.object || payload.ballId || payload.blockId || 'Target_Object'
                });
            } else if (['DROP_FAIL', 'PLACE_FAIL', 'TARGET_MISS', 'POUR_FAIL', 'FEED_FAIL', 'DOOR_FAIL'].includes(event)) {
                this.logTaskOutcome({
                    game: gameId,
                    success: false,
                    object: payload.object || payload.ballId || payload.blockId || 'Target_Object'
                });
            }
        }
    }

    logInteraction({ event, taskId, trialId, gesture, success, latency, value, message, ...payload }) {
        const activeTaskId = taskId || this.currentTaskId || 'GENERAL';
        const activeTrialId = trialId !== undefined ? trialId : this.currentTrialId;
        
        this.logEvent({
            event,
            taskId: activeTaskId,
            trialId: activeTrialId,
            gesture: gesture || this.lastHandPose,
            success,
            latency,
            value,
            message: message || `Game interaction event: ${event}`,
            ...payload
        });
    }

    logMotorIntentDetected({ intent, confidence, ...payload }) {
        const timestampSec = (Date.now() - this._startTime) / 1000;
        const gameId = (this.currentTaskId || 'GENERAL').toUpperCase();
        
        const eventPayload = {
            event: 'MOTOR_INTENT_DETECTED',
            intent,
            confidence,
            timestamp: timestampSec,
            u_pinch: payload.u_pinch ?? 0,
            u_grasp: payload.u_grasp ?? 0,
            s_pinch: payload.s_pinch ?? 0,
            s_grasp: payload.s_grasp ?? 0,
            x_pinch: payload.x_pinch ?? 0,
            x_grasp: payload.x_grasp ?? 0,
            intent_state: intent,
            ...payload
        };
        
        this.logEvent(eventPayload);

        // Perform task/game mapping layer check
        const expected = GAME_EXPECTED_GESTURES[gameId];
        if (expected) {
            const isAllowed = expected.includes(intent.toLowerCase());
            const actionName = isAllowed ? 'EXECUTE_ACTION' : `IGNORE_${intent.toUpperCase()}`;
            
            this.logActionExecuted({
                game: gameId,
                gesture: intent,
                action: actionName,
                status: isAllowed ? 'ACCEPTED' : 'IGNORED'
                // avoid recursion by passing specific flag if needed
            });
        }
    }

    logActionExecuted({ game, gesture, action, status }) {
        const gameId = game.toUpperCase();
        if (!this.taskMappingStats[gameId]) {
            const expectedList = GAME_EXPECTED_GESTURES[gameId] || ['pinch', 'grasp'];
            this.taskMappingStats[gameId] = {
                expected: expectedList.map(g => g.charAt(0).toUpperCase() + g.slice(1)).join('/'),
                executed: 0,
                ignored: 0
            };
        }
        
        const stat = this.taskMappingStats[gameId];
        const isIgnored = action.startsWith('IGNORE_') || status === 'IGNORED';
        if (isIgnored) {
            stat.ignored++;
        } else {
            stat.executed++;
        }

        this.logEvent({
            event: 'ACTION_EXECUTED',
            game: gameId,
            gesture: gesture.toUpperCase(),
            action: action,
            status: isIgnored ? 'IGNORED' : 'ACCEPTED'
        });
    }

    logTaskOutcome({ game, success, object, ...payload }) {
        this.logEvent({
            event: success ? 'TASK_SUCCESS' : 'TASK_FAILED',
            game: game.toUpperCase(),
            success: success,
            object: object || 'unknown',
            ...payload
        });
    }

    logMeasurement({ task, metric, source, formula, value, result }) {
        const timestampStr = this.getTimestamp();
        
        // Dynamic clinical claim terminology sanitization (System validation metric - Not clinical outcome)
        let cleanMetric = metric;
        if (typeof metric === 'string') {
            const lowerMetric = metric.toLowerCase();
            if (lowerMetric === 'clinical stability') {
                cleanMetric = 'System Performance Stability';
            } else if (lowerMetric === 'motor stability') {
                cleanMetric = 'Interaction Stability';
            } else if (lowerMetric === 'transport stability') {
                cleanMetric = 'Object Control Stability';
            }
        }

        // Prevent duplicate logging of the same metric within the same session block
        const isDuplicate = this.stats.measurements.some(m => m.task === task && m.metric === cleanMetric && m.value === value);
        if (!isDuplicate) {
            this.stats.measurements.push({ task, metric: cleanMetric, source, formula, value, result });
        }

        // Print Measurement Log (Layer 3)
        console.log(`%c[Measurement] %c${timestampStr}`, 'color: #FF9800; font-weight: bold;', 'color: #9E9E9E;');
        console.log(`  Task    : ${task}`);
        console.log(`  Metric  : ${cleanMetric}`);
        if (source) console.log(`  Source  : ${source}`);
        if (formula) console.log(`  Formula : ${formula}`);
        if (value !== undefined) {
            const formattedVal = typeof value === 'number' ? value.toFixed(3) : value;
            console.log(`  Value   : ${formattedVal}`);
        }
        if (result !== undefined) console.log(`  Result  : ${result}`);
    }

    logDevDebug(message, ...args) {
        if ((typeof window !== 'undefined' && window.DEBUG_MODE) || DEBUG_MODE) {
            console.log(`%c[DevDebug] ${message}`, 'color: #795548;', ...args);
        }
    }

    // Capture frame state for Research Buffer and tracking transitions
    onFrameUpdate(state) {
        if (!this._sessionStarted) return;

        const now = Date.now();
        const inputState = state?.input;
        const hand = inputState?.hand;
        const isTracking = !!(hand && hand.tracking !== false);
        const currentHandSide = hand?.side ? hand.side.toUpperCase() : 'RIGHT';

        const gameId = (this.currentTaskId || 'GENERAL').toUpperCase();
        const expected = GAME_EXPECTED_GESTURES[gameId];
        const isManipulationGame = !!(expected && expected.length > 0);

        // Update tracking frames for uptime calculation
        this.stats.activeFrames++;
        if (isTracking) {
            this.stats.trackedFrames++;
        }

        // Clinical (debounced) state transitions and timers
        const rawPinchActive = isTracking && isManipulationGame && (hand?.pose === 'pinch');
        const rawGraspActive = isTracking && isManipulationGame && (hand?.pose === 'grasp');

        // Check for clinical pinch timeout (end of clinical gesture)
        if (this.clinicalPinchActive && (now - this.clinicalPinchLastActiveTime >= 100)) {
            const duration = (this.clinicalPinchLastActiveTime - this.clinicalPinchStartTime) / 1000;
            if (duration > 0.05) { // filter out ultra-short flutters
                this.clinicalGestureDurations.pinch.push(duration);
            }
            this.clinicalPinchActive = false;
            this.logEvent({
                event: 'CLINICAL_PINCH_END',
                hand: currentHandSide,
                tracking: true,
                duration,
                message: `Clinical Pinch ended. Duration: ${duration.toFixed(2)}s`
            });
        }

        // Check for clinical grasp timeout (end of clinical gesture)
        if (this.clinicalGraspActive && (now - this.clinicalGraspLastActiveTime >= 100)) {
            const duration = (this.clinicalGraspLastActiveTime - this.clinicalGraspStartTime) / 1000;
            if (duration > 0.05) {
                this.clinicalGestureDurations.grasp.push(duration);
            }
            this.clinicalGraspActive = false;
            this.logEvent({
                event: 'CLINICAL_GRASP_END',
                hand: currentHandSide,
                tracking: true,
                duration,
                message: `Clinical Grasp ended. Duration: ${duration.toFixed(2)}s`
            });
        }

        if (rawPinchActive) {
            if (!this.clinicalPinchActive) {
                this.clinicalPinchActive = true;
                this.clinicalPinchStartTime = now;
                this.clinicalPinchCount++;
                this.logEvent({
                    event: 'CLINICAL_PINCH_BEGIN',
                    hand: currentHandSide,
                    tracking: true,
                    message: `Clinical Pinch started.`
                });
            }
            this.clinicalPinchLastActiveTime = now;
        }

        if (rawGraspActive) {
            if (!this.clinicalGraspActive) {
                this.clinicalGraspActive = true;
                this.clinicalGraspStartTime = now;
                this.clinicalGraspCount++;
                this.logEvent({
                    event: 'CLINICAL_GRASP_BEGIN',
                    hand: currentHandSide,
                    tracking: true,
                    message: `Clinical Grasp started.`
                });
            }
            this.clinicalGraspLastActiveTime = now;
        }

        // 1. Detect Tracking State Transitions
        if (this.lastHandTrackingState === null) {
            this.lastHandTrackingState = isTracking;
            if (isTracking) {
                this.logEvent({
                    event: 'TRACKING_ACQUIRED',
                    hand: currentHandSide,
                    tracking: true,
                    message: `Initial tracking acquired. Confidence: ${(hand.confidence ?? 1.0).toFixed(2)}`
                });
            }
        } else if (this.lastHandTrackingState !== isTracking) {
            this.lastHandTrackingState = isTracking;
            if (isTracking) {
                this.stats.trackingRecoveredEvents++;
                this.logEvent({
                    event: 'TRACKING_RECOVERED',
                    hand: currentHandSide,
                    tracking: true,
                    message: `Tracking recovered.`
                });
            } else {
                this.stats.trackingLostEvents++;
                this.logEvent({
                    event: 'TRACKING_LOST',
                    hand: currentHandSide,
                    tracking: false,
                    message: `Tracking lost.`
                });
            }
        }

        // 2. Detect Hand Switch Transition
        if (isTracking && this.lastHandSide !== currentHandSide) {
            const oldHand = this.lastHandSide;
            this.lastHandSide = currentHandSide;
            this.logEvent({
                event: 'HAND_SWITCH',
                hand: currentHandSide,
                tracking: true,
                message: `Active hand changed from ${oldHand} to ${currentHandSide}.`
            });
        }

        // 3. Detect Gesture Transitions (PINCH / GRASP / NEUTRAL)
        if (isTracking && isManipulationGame) {
            const currentPose = hand.pose || 'neutral';
            const pinchConfidence = hand.pinchConfidence ?? (hand.pinch ? 1.0 : 0.0);
            const graspConfidence = hand.graspConfidence ?? (hand.grasp ? 1.0 : 0.0);

            // Accumulate continuous u_pinch and u_grasp values for session summary statistics
            const uPinchVal = hand.u_pinch ?? hand.pinchProgress ?? 0;
            const uGraspVal = hand.u_grasp ?? hand.graspProgress ?? 0;
            
            this._sessionStatsAccumulator.uPinchSum += uPinchVal;
            this._sessionStatsAccumulator.uPinchCount++;
            if (uPinchVal > this._sessionStatsAccumulator.uPinchMax) {
                this._sessionStatsAccumulator.uPinchMax = uPinchVal;
            }
            
            this._sessionStatsAccumulator.uGraspSum += uGraspVal;
            this._sessionStatsAccumulator.uGraspCount++;
            if (uGraspVal > this._sessionStatsAccumulator.uGraspMax) {
                this._sessionStatsAccumulator.uGraspMax = uGraspVal;
            }

            if (this.lastHandPose !== currentPose) {
                const prevPose = this.lastHandPose;
                this.lastHandPose = currentPose;

                // Log gesture durations
                if (prevPose === 'pinch' || prevPose === 'grasp') {
                    if (this.gestureStartTimes[prevPose]) {
                        const duration = (now - this.gestureStartTimes[prevPose]) / 1000;
                        this.gestureDurations[prevPose].push(duration);
                        delete this.gestureStartTimes[prevPose];
                    }
                }
                if (currentPose === 'pinch' || currentPose === 'grasp') {
                    this.gestureStartTimes[currentPose] = now;
                }

                // Log a GESTURE_CHANGED transition event
                this.logEvent({
                    event: 'GESTURE_CHANGED',
                    hand: currentHandSide,
                    tracking: true,
                    previousPose: prevPose,
                    currentPose,
                    message: `Pose transition: ${prevPose} -> ${currentPose}`
                });

                // Detect fast/unstable transition indicating hand tremor/jitter
                if (this._lastTransitionTime && (now - this._lastTransitionTime < 250)) {
                    this.stats.rapidTransitions++;
                    this.logEvent({
                        event: 'RAPID_TRANSITION',
                        hand: currentHandSide,
                        tracking: true,
                        durationMs: now - this._lastTransitionTime,
                        message: `Rapid gesture state transition detected (${now - this._lastTransitionTime}ms).`
                    });
                }
                this._lastTransitionTime = now;

                const mappedGestureName = currentPose === 'pinch' ? 'PINCH' : (currentPose === 'grasp' ? 'GRASP' : (currentPose === 'open' || currentPose === 'neutral' ? 'OPEN' : 'IDLE'));
                const confidenceVal = mappedGestureName === 'PINCH' ? pinchConfidence : (mappedGestureName === 'GRASP' ? graspConfidence : 1.0);

                this.logMotorIntentDetected({
                    intent: mappedGestureName,
                    confidence: confidenceVal,
                    u_pinch: hand.u_pinch ?? 0,
                    u_grasp: hand.u_grasp ?? 0,
                    s_pinch: hand.sigmaPinch ?? hand.restingPinchStd ?? 0,
                    s_grasp: hand.sigmaGrasp ?? hand.restingGraspStd ?? 0,
                    x_pinch: hand.x_pinch ?? 0,
                    x_grasp: hand.x_grasp ?? 0
                });

                if (currentPose === 'pinch') {
                    this.stats.pinchCount++;
                    this.logEvent({
                        event: 'PINCH_BEGIN',
                        hand: currentHandSide,
                        tracking: true,
                        pinchConfidence,
                        message: `Pinch started.`,
                        decision: {
                            previousPose: prevPose,
                            currentPose: currentPose,
                            signal: 'x_pinch',
                            previousValue: parseFloat((this._prev_x_pinch || 0).toFixed(3)),
                            currentValue: parseFloat((hand.x_pinch || 0).toFixed(3)),
                            threshold: parseFloat((hand.debug?.layer6?.thresholds?.pinchGrab || 1.20).toFixed(3)),
                            decision: 'PINCH_BEGIN'
                        }
                    });
                } else if (prevPose === 'pinch') {
                    this.logEvent({
                        event: 'PINCH_END',
                        hand: currentHandSide,
                        tracking: true,
                        pinchConfidence,
                        message: `Pinch ended.`,
                        decision: {
                            previousPose: prevPose,
                            currentPose: currentPose,
                            signal: 'x_pinch',
                            previousValue: parseFloat((this._prev_x_pinch || 0).toFixed(3)),
                            currentValue: parseFloat((hand.x_pinch || 0).toFixed(3)),
                            threshold: parseFloat((hand.debug?.layer6?.thresholds?.pinchRelease || 0.80).toFixed(3)),
                            decision: 'PINCH_END'
                        }
                    });
                }

                if (currentPose === 'grasp') {
                    this.stats.graspCount++;
                    this.logEvent({
                        event: 'GRASP_BEGIN',
                        hand: currentHandSide,
                        tracking: true,
                        graspConfidence,
                        message: `Grasp started.`,
                        decision: {
                            previousPose: prevPose,
                            currentPose: currentPose,
                            signal: 'x_grasp',
                            previousValue: parseFloat((this._prev_x_grasp || 0).toFixed(3)),
                            currentValue: parseFloat((hand.x_grasp || 0).toFixed(3)),
                            threshold: parseFloat((hand.debug?.layer6?.thresholds?.graspGrab || 1.20).toFixed(3)),
                            decision: 'GRASP_BEGIN'
                        }
                    });
                } else if (prevPose === 'grasp') {
                    this.logEvent({
                        event: 'GRASP_END',
                        hand: currentHandSide,
                        tracking: true,
                        graspConfidence,
                        message: `Grasp ended.`,
                        decision: {
                            previousPose: prevPose,
                            currentPose: currentPose,
                            signal: 'x_grasp',
                            previousValue: parseFloat((this._prev_x_grasp || 0).toFixed(3)),
                            currentValue: parseFloat((hand.x_grasp || 0).toFixed(3)),
                            threshold: parseFloat((hand.debug?.layer6?.thresholds?.graspRelease || 0.80).toFixed(3)),
                            decision: 'GRASP_END'
                        }
                    });
                }
            }
        }

        if (isTracking && hand) {
            this._prev_x_pinch = hand.x_pinch ?? 0;
            this._prev_x_grasp = hand.x_grasp ?? 0;
        }

        // 4. Research Buffer Sampling (10Hz)
        if (((typeof window !== 'undefined' && window.RESEARCH_MODE) || RESEARCH_MODE) && (now - this._lastResearchSample >= this.researchInterval)) {
            this._lastResearchSample = now;
            
            // Extract core state variables if available
            const u_pinch = hand?.u_pinch ?? hand?.pinchProgress ?? null;
            const u_grasp = hand?.u_grasp ?? hand?.graspProgress ?? null;
            const mu_pinch = hand?.equilibrium?.pinch ?? hand?.baselinePinch ?? null;
            const mu_grasp = hand?.equilibrium?.grasp ?? hand?.baselineGrasp ?? null;
            const sigma_pinch = hand?.sigmaPinch ?? hand?.restingPinchStd ?? null;
            const sigma_grasp = hand?.sigmaGrasp ?? hand?.restingGraspStd ?? null;
            const x_pinch = hand?.x_pinch ?? hand?.pinchDistance ?? hand?.pinchEffort ?? null;
            const x_grasp = hand?.x_grasp ?? hand?.graspDistance ?? hand?.graspEffort ?? null;
            const decisionPathPinch = hand?.decisionPathPinch ?? null;
            const decisionPathGrasp = hand?.decisionPathGrasp ?? null;
            const magnitude = hand?.velocity ?? hand?.magnitude ?? null;
            const direction = hand?.direction || null;
            const neutralProbability = hand?.neutralProbability ?? hand?.neutralConfidence ?? null;
            const equilibrium = hand?.equilibrium ?? null;
            const sigma = hand?.sigma ?? hand?.jitter ?? null;

            this.researchBuffer.push({
                timestamp: (now - this._startTime) / 1000,
                frameId: this.stats.activeFrames,
                tracking: isTracking,
                gesture: hand?.pose || 'none',
                pinchConfidence: hand ? (hand.pinchConfidence ?? (hand.pinch ? 1.0 : 0.0)) : 0.0,
                graspConfidence: hand ? (hand.graspConfidence ?? (hand.grasp ? 1.0 : 0.0)) : 0.0,
                handPosition: hand?.position ? { x: hand.position.x, y: hand.position.y, z: hand.position.z } : null,
                velocity: hand?.velocity || 0.0,
                gameState: state?.phase || 'IDLE',
                // Additional reproducible research motor state fields
                u_pinch,
                u_grasp,
                mu_pinch,
                mu_grasp,
                sigma_pinch,
                sigma_grasp,
                x_pinch,
                x_grasp,
                decisionPathPinch,
                decisionPathGrasp,
                magnitude,
                direction,
                neutralProbability,
                equilibrium,
                sigma,
                sourceFPS: (typeof window !== 'undefined' && window.engine?.fps) || 30
            });
        }
    }

    finalizeClinicalGestures() {
        const now = Date.now();
        if (this.clinicalPinchActive && this.clinicalPinchLastActiveTime) {
            const duration = (this.clinicalPinchLastActiveTime - this.clinicalPinchStartTime) / 1000;
            if (duration > 0.05) {
                this.clinicalGestureDurations.pinch.push(duration);
            }
            this.clinicalPinchActive = false;
        }
        if (this.clinicalGraspActive && this.clinicalGraspLastActiveTime) {
            const duration = (this.clinicalGraspLastActiveTime - this.clinicalGraspStartTime) / 1000;
            if (duration > 0.05) {
                this.clinicalGestureDurations.grasp.push(duration);
            }
            this.clinicalGraspActive = false;
        }
    }

    printSessionSummary() {
        if (!this._sessionStarted) return;
        
        this.finalizeClinicalGestures();

        const durationSecs = Math.round((Date.now() - this._startTime) / 1000);
        const durationMins = Math.floor(durationSecs / 60);
        const durationSecsRemainder = durationSecs % 60;
        const durationStr = `${durationMins} min ${durationSecsRemainder} s`;

        const trackingUptime = this.stats.activeFrames > 0 
            ? ((this.stats.trackedFrames / this.stats.activeFrames) * 100).toFixed(1)
            : "100.0";

        const outcomes = this.eventHistory.filter(e => e.event === 'TASK_COMPLETED' || e.event === 'TASK_FAILED');
        const completedGames = this.stats.completedGames || (outcomes.length > 0 ? outcomes.length : 0) || (typeof window !== 'undefined' && window.engine?.state?.currentSequenceIndex) || 0;
        const totalGames = this.stats.totalGames || (typeof window !== 'undefined' && window.engine?.state?.sessionPlan?.length) || Math.max(1, completedGames);
        
        let successRate = this.stats.successRateCount > 0
            ? Math.round(this.stats.successRateTotal / this.stats.successRateCount)
            : 0;

        if (successRate === 0 && outcomes.length > 0) {
            const successfulOutcomes = outcomes.filter(e => e.success === true).length;
            successRate = Math.round((successfulOutcomes / outcomes.length) * 100);
        }

        const getAvgDuration = (arr) => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
        const avgPinchDur = getAvgDuration(this.gestureDurations.pinch);
        const avgGraspDur = getAvgDuration(this.gestureDurations.grasp);

        const clinicalAvgPinchDur = getAvgDuration(this.clinicalGestureDurations.pinch);
        const clinicalAvgGraspDur = getAvgDuration(this.clinicalGestureDurations.grasp);

        const totalInteractions = this.eventHistory.filter(e => e.event && !['SESSION_START', 'TRACKING_ACQUIRED', 'TRACKING_LOST', 'TRACKING_RECOVERED', 'HAND_SWITCH', 'GESTURE_CHANGED', 'RAPID_TRANSITION', 'PINCH_BEGIN', 'PINCH_END', 'GRASP_BEGIN', 'GRASP_END', 'CLINICAL_PINCH_BEGIN', 'CLINICAL_PINCH_END', 'CLINICAL_GRASP_BEGIN', 'CLINICAL_GRASP_END', 'MOTOR_INTENT_DETECTED'].includes(e.event)).length;

        console.log(`======================================================================
REHABREACH EXECUTION VALIDATION & MOTOR INTERACTION ANALYSIS REPORT
======================================================================
Session ID : ${this.sessionId}
Duration   : ${durationStr}
Framework  : A Framework for Adaptive Motor Intent Representation and Contextual Interaction Analysis

Application-Level Execution Outcomes (Kết quả thực thi mức ứng dụng)
------------------------------------
Completion   : ${completedGames} / ${totalGames} games completed
Success rate : ${successRate} % (overall task success)

Table X. Multi-layer Execution Validation (Xác thực thực thi đa tầng)
----------------------------------------------------------------------
[Layer 1] Observation Layer (Tầng theo dõi quang học)
  - Tracking Uptime (Thời gian hoạt động theo dõi) : ${trackingUptime} %
  - Source Frame Rate (FPS nguồn)                  : ${(typeof window !== 'undefined' && window.engine?.fps) || 30} Hz
  - Tracking Interruptions (Số lần ngắt kết nối)   : ${this.stats.trackingLostEvents}
  - Tracking Recoveries (Số lần khôi phục)         : ${this.stats.trackingRecoveredEvents}

[Layer 2] Feature Representation Layer (Mức biểu diễn đặc trưng liên tục)
  - Total Continuous Pinch Intent (Tổng ý định Pinch)   : ${this.stats.pinchCount}
  - Total Continuous Grasp Intent (Tổng ý định Grasp)   : ${this.stats.graspCount}
  - Jitter Stability (Rapid Transitions) (Độ ổn định)   : ${this.stats.rapidTransitions}

[Layer 3 & 4] Adaptive Baseline Estimation & Baseline-Referenced Motor Representation (BRMR)
  Game       | Required Motor Intent | Accepted Actions  | Non-mapped Intent Events
  ------------------------------------------------------------------------------------`);

        const gamesTracked = Object.keys(this.taskMappingStats);
        if (gamesTracked.length === 0) {
            console.log(`  (No tasks played yet in this session)`);
        } else {
            gamesTracked.forEach(gameId => {
                const stat = this.taskMappingStats[gameId];
                const expectedCol = stat.expected.toUpperCase().padEnd(21);
                const executedCol = String(stat.executed).padEnd(17);
                const ignoredCol = String(stat.ignored);
                console.log(`  ${gameId.padEnd(10)} | ${expectedCol} | ${executedCol} | ${ignoredCol}`);
            });
        }

        console.log(`
[Layer 5 & 6] Continuous Motor State & Interaction Mapping (Tầng thực thi game & Ánh xạ tương tác)
  - Completed Tasks count  : ${completedGames}
  - Overall Success Rate   : ${successRate} %
  - Executed Actions count : ${totalInteractions}

Standardized Digital Motor Interaction Measurements:`);
        if (this.stats.measurements.length === 0) {
            console.log("  No measurements recorded.");
        } else {
            this.stats.measurements.forEach(m => {
                const formattedVal = typeof m.value === 'number' ? m.value.toFixed(3) : m.value;
                const resultSuffix = m.result ? ` (${m.result})` : '';
                console.log(`  - ${m.metric} (${m.task}) : ${formattedVal}${resultSuffix}`);
            });
        }
        console.log(`======================================================================`);
    }

    endSession() {
        if (!this._sessionStarted) return;
        this.finalizeClinicalGestures();
        this.logEvent({
            event: 'SESSION_FINISHED',
            taskId: this.currentTaskId,
            message: 'Validation session finished.'
        });
        this.printSessionSummary();
        this.downloadJSON();
        this._sessionStarted = false;
    }

    stopSession() {
        this.endSession();
    }

    getSummaryStatistics() {
        let totalPinchDuration = this.gestureDurations.pinch.reduce((sum, d) => sum + d, 0);
        if (this.gestureStartTimes['pinch']) {
            totalPinchDuration += (Date.now() - this.gestureStartTimes['pinch']) / 1000;
        }

        let totalGraspDuration = this.gestureDurations.grasp.reduce((sum, d) => sum + d, 0);
        if (this.gestureStartTimes['grasp']) {
            totalGraspDuration += (Date.now() - this.gestureStartTimes['grasp']) / 1000;
        }

        const meanUPinch = this._sessionStatsAccumulator.uPinchCount > 0 
            ? (this._sessionStatsAccumulator.uPinchSum / this._sessionStatsAccumulator.uPinchCount) 
            : 0;
        const meanUGrasp = this._sessionStatsAccumulator.uGraspCount > 0 
            ? (this._sessionStatsAccumulator.uGraspSum / this._sessionStatsAccumulator.uGraspCount) 
            : 0;

        const outcomes = this.eventHistory.filter(e => e.event === 'TASK_COMPLETED' || e.event === 'TASK_FAILED');
        let successRate = this.stats.successRateCount > 0
            ? Math.round(this.stats.successRateTotal / this.stats.successRateCount)
            : 0;

        if (successRate === 0 && outcomes.length > 0) {
            const successfulOutcomes = outcomes.filter(e => e.success === true).length;
            successRate = Math.round((successfulOutcomes / outcomes.length) * 100);
        }

        const trackingUptime = this.stats.activeFrames > 0 
            ? ((this.stats.trackedFrames / this.stats.activeFrames) * 100)
            : 100.0;

        return {
            mean_u_pinch: parseFloat(meanUPinch.toFixed(4)),
            max_u_pinch: parseFloat(this._sessionStatsAccumulator.uPinchMax.toFixed(4)),
            mean_u_grasp: parseFloat(meanUGrasp.toFixed(4)),
            max_u_grasp: parseFloat(this._sessionStatsAccumulator.uGraspMax.toFixed(4)),
            total_pinch_intent_duration_sec: parseFloat(totalPinchDuration.toFixed(2)),
            total_grasp_intent_duration_sec: parseFloat(totalGraspDuration.toFixed(2)),
            number_of_accepted_actions: this._sessionStatsAccumulator.acceptedActions,
            number_of_rejected_actions: this._sessionStatsAccumulator.rejectedActions,
            execution_success_rate_percent: successRate,
            tracking_uptime_percent: parseFloat(trackingUptime.toFixed(1))
        };
    }

    exportJSON() {
        const metadata = this.getMetadata();
        this.finalizeClinicalGestures();
        return JSON.stringify({
            loggerVersion: metadata.loggerVersion,
            sessionId: this.sessionId,
            startTime: new Date(this._startTime).toISOString(),
            endTime: new Date().toISOString(),
            metadata,
            summaryStatistics: this.getSummaryStatistics(),
            stats: {
                ...this.stats,
                trackingUptimePercent: this.stats.activeFrames > 0 ? (this.stats.trackedFrames / this.stats.activeFrames) * 100 : 0
            },
            clinicalStats: {
                clinicalPinchCount: this.clinicalPinchCount,
                clinicalGraspCount: this.clinicalGraspCount,
                clinicalGestureDurations: this.clinicalGestureDurations,
                clinicalAvgPinchDuration: this.clinicalGestureDurations.pinch.length > 0 ? (this.clinicalGestureDurations.pinch.reduce((a, b) => a + b, 0) / this.clinicalGestureDurations.pinch.length) : 0,
                clinicalAvgGraspDuration: this.clinicalGestureDurations.grasp.length > 0 ? (this.clinicalGestureDurations.grasp.reduce((a, b) => a + b, 0) / this.clinicalGestureDurations.grasp.length) : 0
            },
            eventHistory: this.eventHistory,
            researchBuffer: this.researchBuffer
        }, null, 2);
    }

    downloadJSON() {
        try {
            const dataStr = this.exportJSON();
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const exportFileDefaultName = `rehabreach_session_${this.sessionId || 'log'}.json`;
            
            const linkElement = document.createElement('a');
            linkElement.setAttribute('href', url);
            linkElement.setAttribute('download', exportFileDefaultName);
            linkElement.click();
            URL.revokeObjectURL(url);
            console.log(`Successfully downloaded session log: ${exportFileDefaultName}`);
        } catch (e) {
            console.error('Failed to download session JSON:', e);
        }
    }
}

export const ValidationLogger = new ValidationLoggerClass();

// Attach globally for accessibility and developer tools
if (typeof window !== 'undefined') {
    window.ValidationLogger = ValidationLogger;
    window.DEBUG_MODE = window.DEBUG_MODE ?? false;
    window.RESEARCH_MODE = window.RESEARCH_MODE ?? false;
}