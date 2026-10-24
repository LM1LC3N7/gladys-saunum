// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES, STATE } from './constants.js';

export const both = (en, fr) => ({ en, fr });
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Saunum sauna', 'Sauna Saunum');

export const FEATURE_NAMES = {
  [FEATURES.SESSION]: both('Session on', 'Séance en cours'),
  [FEATURES.STATE]: both('State', 'État'),
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.HUMIDITY]: both('Humidity', 'Humidité'),
  [FEATURES.DOOR]: both('Door', 'Porte'),
  [FEATURES.HEATERS]: both('Heater elements on', 'Résistances en marche'),
  [FEATURES.ALARM]: both('Alarm', 'Alarme'),
  [FEATURES.TARGET]: both('Setpoint', 'Consigne'),
  [FEATURES.REMAINING]: both('Session time left', 'Temps de séance restant'),
  [FEATURES.LIGHT]: both('Light', 'Lumière'),
  [FEATURES.HEAT_ON]: both('Turn on (heat)', 'Allumer (chauffer)'),
  [FEATURES.HEAT_OFF]: both('Turn off', 'Éteindre'),
};

export const STATE_NAMES = {
  [STATE.STANDBY]: both('Standby', 'En veille'),
  [STATE.SCHEDULED]: both('Scheduled', 'Programmé'),
  [STATE.HEATING]: both('Heating', 'En chauffe'),
  [STATE.READY]: both('Ready', 'Prêt'),
  [STATE.COOLDOWN]: both('Cooling down', 'Refroidissement'),
  [STATE.WAITING_FOR_DOOR]: both('Waiting for the door', 'En attente de la porte'),
};

const ALARM_TEXT = both('alarm', 'alarme');

/** The state of the panel in words (register 109 when served, else from the session). */
export function stateText(data) {
  let text;
  if (data.state !== undefined) {
    text = STATE_NAMES[data.state];
  } else if (!data.sessionActive) {
    text = both('Off', 'Arrêté');
  } else if (data.target === 0) {
    text = STATE_NAMES[STATE.COOLDOWN];
  } else {
    text = both('Session on', 'Séance en cours');
  }
  return data.alarm ? both(`${text.en}, ${ALARM_TEXT.en}`, `${text.fr}, ${ALARM_TEXT.fr}`) : text;
}

const LINK = both('then use “Test the connection”.', 'puis utilisez « Tester la connexion ».');

/** Statuses of the integration (configuration screen). */
export const T = {
  noAddress: both(
    'Enter the address of the Saunum control panel.',
    'Saisissez l’adresse du panneau de commande Saunum.',
  ),
  badAddress: both(
    'The address is not valid: an IPv4 address or a host name, optionally followed by “:port”.',
    'L’adresse n’est pas valide : une adresse IPv4 ou un nom d’hôte, suivi éventuellement de « :port ».',
  ),
  badUnit: both(
    'The Modbus unit id must be a whole number from 1 to 247.',
    'L’identifiant d’unité Modbus doit être un nombre entier de 1 à 247.',
  ),
  connecting: both('Connecting to the panel…', 'Connexion au panneau…'),
  configRetry: (wait) =>
    both(
      `The configuration could not be loaded from Gladys: next try in ${wait.en}.`,
      `La configuration n’a pas pu être chargée depuis Gladys : nouvel essai dans ${wait.fr}.`,
    ),
  waiting: (wait) =>
    both(`Next read of the sauna in ${wait.en}.`, `Prochaine lecture du sauna dans ${wait.fr}.`),
  connected: (summary) => both(`Connected: ${summary.en}.`, `Connecté : ${summary.fr}.`),
  lastRead: (when) => both(`Last read ${when.en} ago.`, `Dernière lecture il y a ${when.fr}.`),
  unreachable: (reason, wait) =>
    join(
      both(
        `The panel does not answer (${reason}): next try in ${wait.en}. Check the address, that Modbus is on, and that no other Modbus client holds the connection;`,
        `Le panneau ne répond pas (${reason}) : nouvel essai dans ${wait.fr}. Vérifiez l’adresse, que Modbus est activé et qu’aucun autre client Modbus ne tient la connexion ;`,
      ),
      LINK,
    ),
  summary: (data) => {
    const state = stateText(data);
    const temp =
      data.temperature === undefined
        ? both('', '')
        : both(`, ${data.temperature} °C`, `, ${data.temperature} °C`);
    const door = data.doorOpen ? both(', door open', ', porte ouverte') : both('', '');
    return both(`${state.en}${temp.en}${door.en}`, `${state.fr}${temp.fr}${door.fr}`);
  },
};

/** Warnings kept in the status until the next start from Gladys or a new configuration. */
export const WARNINGS = {
  launchMismatch: (reason) =>
    both(
      `Warning: the session started from Gladys did not keep its values (${reason.en}): turn off asked.`,
      `Attention : la séance lancée depuis Gladys n’a pas gardé ses valeurs (${reason.fr}) : extinction demandée.`,
    ),
  launchUnverified: both(
    'Warning: the session started from Gladys could not be checked on a read within 1 min: turn off asked.',
    'Attention : la séance lancée depuis Gladys n’a pas pu être vérifiée par une lecture en 1 min : extinction demandée.',
  ),
  launchNotStarted: both(
    'Warning: the panel did not start the session asked from Gladys (the reads show it off): turn off asked.',
    'Attention : le panneau n’a pas lancé la séance demandée depuis Gladys (les lectures la montrent arrêtée) : extinction demandée.',
  ),
  stopNoEffect: both(
    'Warning: a turn off did not take effect (the sauna still heats): sent again.',
    'Attention : une extinction n’a pas pris effet (le sauna chauffe encore) : renvoyée.',
  ),
  reasons: {
    setpoint: both(
      'setpoint above the highest one, or the preset’s',
      'consigne au-dessus de la plus haute, ou celle du préréglage',
    ),
    duration: both(
      'session duration 0 or longer than the one written',
      'durée de séance à 0 ou plus longue que celle écrite',
    ),
  },
};

/** The end of a refusal: what was (not) written. */
export const OUTCOME = {
  nothing: both('Nothing sent.', 'Rien envoyé.'),
  notStarted: both(
    'The session was not started (the setpoint and the duration of the next session may have been written).',
    'La séance n’a pas été lancée (la consigne et la durée de la prochaine séance ont pu être écrites).',
  ),
};

/** Refusals of the commands (shown by Gladys when the ack fails). */
export const ERRORS = {
  readOnly: both('This feature cannot be set.', 'Cette fonctionnalité ne peut pas être commandée.'),
  badButton: both('A button only takes 1.', 'Un bouton ne prend que 1.'),
  badLight: both('The light only takes 0 or 1.', 'La lumière ne prend que 0 ou 1.'),
  badSetpoint: (min, max) =>
    both(
      `The setpoint must be a whole number from ${min} to ${max} °C (“Highest setpoint”).`,
      `La consigne doit être un nombre entier de ${min} à ${max} °C (« Consigne la plus haute »).`,
    ),
  heatingDisabled: both(
    'Heating from Gladys is off: turn on “Allow heating from Gladys” in the configuration. Turning off does not depend on this option.',
    'Le chauffage depuis Gladys est désactivé : activez « Autoriser le chauffage depuis Gladys » dans la configuration. L’extinction ne dépend pas de cette option.',
  ),
  unknownDevice: both(
    'This device is not the panel of this integration, or its configuration changed.',
    'Cet appareil n’est pas le panneau de cette intégration, ou sa configuration a changé.',
  ),
  noConfig: both('No panel address configured.', 'Aucune adresse de panneau configurée.'),
  badAddress: both(
    'The panel address of the configuration is not valid.',
    'L’adresse du panneau dans la configuration n’est pas valide.',
  ),
  badUnit: both(
    'The Modbus unit id of the configuration is not valid (1 to 247).',
    'L’identifiant d’unité Modbus de la configuration n’est pas valide (1 à 247).',
  ),
  notLoaded: both(
    'The configuration is not loaded yet.',
    'La configuration n’est pas encore chargée.',
  ),
  foreign: both(
    'The device at this address does not look like a Saunum panel (a register outside its documented range).',
    'L’appareil à cette adresse ne ressemble pas à un panneau Saunum (un registre hors de sa plage documentée).',
  ),
  identityChanged: both(
    'The panel no longer serves the registers 105-118 it served before (another device at this address?): heating refused.',
    'Le panneau ne sert plus les registres 105 à 118 qu’il servait (un autre appareil à cette adresse ?) : chauffe refusée.',
  ),
  notYetSent: both(
    'Not sent yet (panel busy or connection in progress): it leaves as soon as possible, check the sauna.',
    'Pas encore envoyée (panneau occupé ou connexion en cours) : elle part dès que possible, vérifiez le sauna.',
  ),
  checkSauna: both('Check the sauna.', 'Vérifiez le sauna.'),
  busyRetried: both(
    'Tried once more; check the sauna.',
    'Un nouvel essai est fait ; vérifiez le sauna.',
  ),
  stopMeanwhile: both(
    'A turn off was asked meanwhile.',
    'Une extinction a été demandée entre-temps.',
  ),
  stopPending: both(
    'A turn off is in flight or not confirmed yet: heating refused.',
    'Une extinction est en cours ou pas encore confirmée : chauffe refusée.',
  ),
  justStopped: both(
    'A turn off was asked less than 2 min ago: setpoint refused.',
    'Une extinction a été demandée il y a moins de 2 min : consigne refusée.',
  ),
  busy: both(
    'Another heating command is in progress.',
    'Une autre commande de chauffe est en cours.',
  ),
  inProgress: both(
    'The previous start is not confirmed yet: try again in a minute.',
    'Le lancement précédent n’est pas encore confirmé : réessayez dans une minute.',
  ),
  tooSlowToWrite: both(
    'The panel answers too slowly to write everything within 3.5 s.',
    'Le panneau répond trop lentement pour tout écrire dans les 3,5 s.',
  ),
  tooSlow: both('The panel did not answer in time.', 'Le panneau n’a pas répondu à temps.'),
  unknownState: (reason) =>
    both(
      `The state of the sauna could not be read (${reason}).`,
      `L’état du sauna n’a pas pu être lu (${reason}).`,
    ),
  notRead: both(
    'The panel has not been read successfully yet.',
    'Le panneau n’a pas encore été lu avec succès.',
  ),
  missing: both(
    'The state of the sauna is incomplete (setpoint, alarm or controller state unknown).',
    'L’état du sauna est incomplet (consigne, alarme ou état du boîtier inconnu).',
  ),
  doorOpen: both(
    'The sauna door is open: heating refused.',
    'La porte du sauna est ouverte : chauffe refusée.',
  ),
  alarm: both(
    'An alarm is on at the panel: heating refused.',
    'Une alarme est active sur le panneau : chauffe refusée.',
  ),
  startBlocked: (mask) =>
    both(
      `The panel reports a reason not to start (code 0x${mask}): heating refused.`,
      `Le panneau signale une raison de ne pas démarrer (code 0x${mask}) : chauffe refusée.`,
    ),
  cannotStart: (state) =>
    both(
      `The sauna cannot start now (${state.en}).`,
      `Le sauna ne peut pas démarrer maintenant (${state.fr}).`,
    ),
  coolingDown: both(
    'The sauna is cooling down: setpoint refused (it could heat again).',
    'Le sauna refroidit : consigne refusée (elle pourrait relancer la chauffe).',
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Non envoyée (${reason}).`),
  refused: (reason) =>
    both(
      `The panel refused the command (${reason}).`,
      `Le panneau a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): check the sauna.`,
      `Envoyée, sans confirmation (${reason}) : vérifiez le sauna.`,
    ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
};
