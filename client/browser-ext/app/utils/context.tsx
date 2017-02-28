import { EventLogger } from "../tracking/EventLogger";
import { ExtensionEventLogger } from "../tracking/ExtensionEventLogger";

export let eventLogger: EventLogger;

export function setEventLogger(logger: EventLogger): void {
	if (eventLogger) {
		console.error(`event logger is being set twice, currently is ${eventLogger} and being set to ${logger}`);
	}
	eventLogger = logger;
}

export let sourcegraphUrl: string;

export function setSourcegraphUrl(url: string): void {
	if (sourcegraphUrl) {
		console.error(`event logger is being set twice, currently is ${sourcegraphUrl} and being set to ${url}`);
	}
	sourcegraphUrl = url;
}
