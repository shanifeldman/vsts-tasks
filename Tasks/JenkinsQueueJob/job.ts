/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/shelljs.d.ts"/>

import tl = require('vsts-task-lib/task');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');

// node js modules
var request = require('request');

import jobsearch = require('./jobsearch');
import JobSearch = jobsearch.JobSearch;
import jobqueue = require('./jobqueue');
import JobQueue = jobqueue.JobQueue;

import * as Util from './util';

export enum JobState {
    New,       // 0
    Locating,  // 1
    Streaming, // 2
    Finishing, // 3
    Done,      // 4
    Joined,    // 5
    Queued,    // 6
    Cut        // 7
}

export class Job {
    parent: Job; // if this job is a pipelined job, its parent that started it.
    children: Job[] = []; // any pipelined jobs
    joined: Job; // if this job is joined, the main job that is running
    search: JobSearch;
    queue: JobQueue;

    taskUrl: string; // URL for the job definition

    state: JobState = JobState.New;
    executableUrl: string; // URL for the executing job instance
    executableNumber: number;
    name: string;
    jobConsole: string = "";
    jobConsoleOffset: number = 0;
    jobConsoleEnabled: boolean = false;

    working: boolean = false;
    workDelay: number = 0;

    parsedExecutionResult; // set during state Finishing

    constructor(jobQueue: JobQueue, parent: Job, taskUrl: string, executableUrl: string, executableNumber: number, name: string) {
        this.parent = parent;
        this.taskUrl = taskUrl;
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        if (this.parent != null) {
            this.parent.children.push(this);
        }
        this.queue = jobQueue;
        this.queue.addJob(this);

        this.debug('created');
        this.initialize();
    }

    /**
     * All changes to the job state should be routed through here.  
     * This defines all and validates all state transitions.
     */
    changeState(newState: JobState) {
        var oldState = this.state;
        this.state = newState;
        if (oldState != newState) {
            this.debug('state changed from: ' + oldState);
            var validStateChange = false;
            if (oldState == JobState.New) {
                validStateChange = (newState == JobState.Locating || newState == JobState.Streaming || newState == JobState.Joined || newState == JobState.Cut);
            } else if (oldState == JobState.Locating) {
                validStateChange = (newState == JobState.Streaming || newState == JobState.Joined || newState == JobState.Cut);
            } else if (oldState == JobState.Streaming) {
                validStateChange = (newState == JobState.Finishing);
            } else if (oldState == JobState.Finishing) {
                validStateChange = (newState == JobState.Done);
            } else if (oldState == JobState.Done || oldState == JobState.Joined || oldState == JobState.Cut) {
                validStateChange = false; // these are terminal states
            }
            if (!validStateChange) {
                Util.fail('Invalid state change from: ' + oldState + ' ' + this);
            }
        }
    }

    doWork() {
        if (this.working) { // return if already working
            return;
        } else {
            this.working = true;
            setTimeout(() => {
                if (this.state == JobState.Streaming) {
                    this.streamConsole();
                } else if (this.state == JobState.Finishing) {
                    this.finish();
                } else {
                    // usually do not get here, but this can happen if another callback caused this job to be joined
                    this.stopWork(this.queue.pollInterval, null);
                }
            }, this.workDelay);
        }
    }

    stopWork(delay: number, jobState: JobState) {
        if (jobState && jobState != this.state) {
            this.changeState(jobState);
            if (!this.isActive()) {
                this.queue.flushJobConsolesSafely();
            }
        }
        this.workDelay = delay;
        this.working = false;
    }

    isActive(): boolean {
        return this.state == JobState.New ||
            this.state == JobState.Locating ||
            this.state == JobState.Streaming ||
            this.state == JobState.Finishing
    }

    setStreaming(executableNumber: number): void {
        if (this.state == JobState.New || this.state == JobState.Locating) {
            this.executableNumber = executableNumber;
            this.executableUrl = Util.addUrlSegment(this.taskUrl, this.executableNumber.toString());
            this.changeState(JobState.Streaming);

            this.consoleLog('******************************************************************************\n');
            this.consoleLog('Jenkins job started: ' + this.name + '\n');
            this.consoleLog(this.executableUrl + '\n');
            this.consoleLog('******************************************************************************\n');

            if (this.queue.findActiveConsoleJob() == null) {
                console.log('Jenkins job pending: ' + this.executableUrl);
            }
        } else if (this.state == JobState.Joined || this.state == JobState.Cut) {
            Util.fail('Can not be set to streaming: ' + this);
        }
        this.joinOthersToMe();
    }

    joinOthersToMe() {
        //join all other siblings to this same job (as long as it's not root)
        var thisJob: Job = this;
        if (thisJob.parent != null) {
            thisJob.search.determineMainJob(thisJob.executableNumber, function (mainJob: Job, secondaryJobs: Job[]) {
                if (mainJob != thisJob) {
                    Util.fail('Illegal call in joinOthersToMe(), job:' + thisJob);
                }
                for (var i in secondaryJobs) {
                    var secondaryJob = secondaryJobs[i];
                    if (secondaryJob.state != JobState.Cut) {
                        secondaryJob.setJoined(thisJob);
                    }
                }
            });
        }
    }

    setJoined(joinedJob: Job): void {
        tl.debug(this + '.setJoined(' + joinedJob + ')');
        this.joined = joinedJob;
        this.changeState(JobState.Joined);
        if (joinedJob.state == JobState.Joined || joinedJob.state == JobState.Cut) {
            Util.fail('Invalid join: ' + this);
        }

        // recursively cut all children
        for (var i in this.children) {
            this.children[i].cut();
        }
    }

    cut(): void {
        this.changeState(JobState.Cut);
        for (var i in this.children) {
            this.children[i].cut();
        }
    }

    setParsedExecutionResult(parsedExecutionResult) {
        this.parsedExecutionResult = parsedExecutionResult;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    getTaskResult(): number {
        if (this.state == JobState.Queued) {
            return tl.TaskResult.Succeeded;
        } else if (this.state == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            if (resultCode == "SUCCESS" || resultCode == 'UNSTABLE') {
                return tl.TaskResult.Succeeded;
            } else {
                return tl.TaskResult.Failed;
            }
        }
        return tl.TaskResult.Failed;
    }

    getResultString(): string {
        if (this.state == JobState.Queued) {
            return 'Queued';
        } else if (this.state == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            // codes map to fields in http://hudson-ci.org/javadoc/hudson/model/Result.html
            if (resultCode == 'SUCCESS') {
                return 'Success';
            } else if (resultCode == 'UNSTABLE') {
                return 'Unstable';
            } else if (resultCode == 'FAILURE') {
                return 'Failure';
            } else if (resultCode == 'NOT_BUILT') {
                return 'Not built';
            } else if (resultCode == 'ABORTED') {
                return 'Aborted';
            } else {
                return resultCode;
            }
        } else return 'Unknown';
    }

    initialize() {
        var thisJob = this;
        thisJob.search.initialize().then(() => {
            if (thisJob.search.initialized) {
                if (thisJob.queue.capturePipeline) {
                    var downstreamProjects = thisJob.search.parsedTaskBody.downstreamProjects;
                    downstreamProjects.forEach((project) => {
                        new Job(thisJob.queue, thisJob, project.url, null, -1, project.name); // will add a new child to the tree
                    });
                }
                thisJob.search.resolveIfKnown(thisJob); // could change state
                var newState = (thisJob.state == JobState.New) ? JobState.Locating : thisJob.state; // another call back could also change state 
                var nextWorkDelay = (newState == JobState.Locating) ? thisJob.queue.pollInterval : thisJob.workDelay;
                thisJob.stopWork(nextWorkDelay, newState);
            } else {
                //search not initialized, so try again
                thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
            }
        }).fail((err) => {
            throw err;
        });
    }

    /**
     * Checks the success of the job
     * 
     * JobState = Finishing, transition to Done or Queued possible
     */
    finish(): void {
        var thisJob = this;
        tl.debug('finish()');
        if (!thisJob.queue.captureConsole) { // transition to Queued
            thisJob.stopWork(0, JobState.Queued);
        } else { // stay in Finishing, or eventually go to Done
            var resultUrl = Util.addUrlSegment(thisJob.executableUrl, 'api/json');
            thisJob.debug('Tracking completion status of job: ' + resultUrl);
            request.get({ url: resultUrl }, function requestCallback(err, httpResponse, body) {
                tl.debug('finish().requestCallback()');
                if (err) {
                    Util.handleConnectionResetError(err); // something went bad
                    thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
                    return;
                } else if (httpResponse.statusCode != 200) {
                    Util.failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
                } else {
                    var parsedBody = JSON.parse(body);
                    thisJob.debug("parsedBody for: " + resultUrl + ": " + JSON.stringify(parsedBody));
                    if (parsedBody.result) {
                        thisJob.setParsedExecutionResult(parsedBody);
                        thisJob.stopWork(0, JobState.Done);
                    } else {
                        // result not updated yet -- keep trying
                        thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
                    }
                }
            }).auth(thisJob.queue.username, thisJob.queue.password, true);
        }
    }
    /**
     * Streams the Jenkins console.
     * 
     * JobState = Streaming, transition to Finishing possible.
     */
    streamConsole(): void {
        var thisJob = this;
        var fullUrl = Util.addUrlSegment(thisJob.executableUrl, '/logText/progressiveText/?start=' + thisJob.jobConsoleOffset);
        thisJob.debug('Tracking progress of job URL: ' + fullUrl);
        request.get({ url: fullUrl }, function requestCallback(err, httpResponse, body) {
            tl.debug('streamConsole().requestCallback()');
            if (err) {
                Util.handleConnectionResetError(err); // something went bad
                thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
                return;
            } else if (httpResponse.statusCode == 404) {
                // got here too fast, stream not yet available, try again in the future
                thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
            } else if (httpResponse.statusCode != 200) {
                Util.failReturnCode(httpResponse, 'Job progress tracking failed to read job progress');
            } else {
                thisJob.consoleLog(body); // redirect Jenkins console to task console
                var xMoreData = httpResponse.headers['x-more-data'];
                if (xMoreData && xMoreData == 'true') {
                    var offset = httpResponse.headers['x-text-size'];
                    thisJob.jobConsoleOffset = offset;
                    thisJob.stopWork(thisJob.queue.pollInterval, thisJob.state);
                } else { // no more console, move to Finishing
                    thisJob.stopWork(0, JobState.Finishing);
                }
            }
        }).auth(thisJob.queue.username, thisJob.queue.password, true);;
    }
    enableConsole() {
        var thisJob = this;
        if (thisJob.queue.captureConsole) {
            if (!this.jobConsoleEnabled) {
                if (this.jobConsole != "") { // flush any queued output
                    console.log(this.jobConsole);
                }
                this.jobConsoleEnabled = true;
            }
        }
    }

    isConsoleEnabled() {
        return this.jobConsoleEnabled;
    }

    consoleLog(message: string) {
        if (this.jobConsoleEnabled) {
            //only log it if the console is enabled.
            console.log(message);
        }
        this.jobConsole += message;
    }

    debug(message: string) {
        var fullMessage = this.toString() + ' debug: ' + message;
        tl.debug(fullMessage);
    }

    toString() {
        var fullMessage = '(' + this.state + ':' + this.name + ':' + this.executableNumber;
        if (this.parent != null) {
            fullMessage += ', p:' + this.parent;
        }
        if (this.joined != null) {
            fullMessage += ', j:' + this.joined;
        }
        fullMessage += ')';
        return fullMessage;
    }
}
