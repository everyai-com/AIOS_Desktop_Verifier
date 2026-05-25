// Probe registry. Add new probes here as features ship.

import { smokeLaunchChat } from './smoke-launch-chat.js';
import { sentryInit } from './sentry-init.js';

export const probes = [smokeLaunchChat, sentryInit];
