/**
 * Also create a file `secrets.gs` with your bot token:
function getBotToken() {
    return '<the token>';
}
function getWebAppUrl() {
    return 'https://script.google.com/macros/s/...../exec';
}
 */

/** API docs: https://core.telegram.org/bots/api#sendmessage
 * */
const BOT_TOKEN = getBotToken();     // add your bot Token
const WEBAPP_URL = getWebAppUrl();  // add your script URL after the deployment

const BOT_NAME = 'MissedProposalsBot'; // Telegram username
const CHAT_ID = '-1002298175976';  // the real group
const TEST_CHAT_ID = '-1002298175976'; // set to "-1" to simply log messages
const initialStateVersion = '185041900'; // Starting point for this Spreadsheet

var telegramUrl = "https://api.telegram.org/bot" + BOT_TOKEN;

const POLL_INTERVAL = 5000;
const waitingTime = 60; // can be 1 or 5 minutes
const waitingTimeMs = waitingTime * 1000;

const MESSAGES_TO_STORE = 100;


// Stores the last processed state version in cell A2, Max seen version in cell B2
const ss = SpreadsheetApp.getActiveSpreadsheet();
const [svCell, maxSvCell, messagesRange] = getStateVersionStorage();

/* State version stuff */
function getStateVersionStorage() {
    let sheet = ss.getSheetByName('last_state_version');

    // Create the sheet if it doesn't exist
    if (!sheet) {
        sheet = ss.insertSheet('last_state_version');
        sheet.appendRow(['State Version', 'Max Seen Version']);

        sheet.getRange("A9:F9").merge().setHorizontalAlignment('center').setValue(`Last ${MESSAGES_TO_STORE} messages`);
        sheet.getRange("A10").setValue("Chat ID");
        sheet.getRange("B10").setValue("Message ID");
        sheet.getRange("C10").setValue("Validator");
        sheet.getRange("D10").setValue("Epoch");
        sheet.getRange("E10").setValue("Round");
        sheet.getRange("F10").setValue("MissedCount");
    }

    return [sheet.getRange("A2"), sheet.getRange("B2"), sheet.getRange("A11:F" + (11 + MESSAGES_TO_STORE - 1))];
}

function getLastStateVersion() {
    let versionNumber = svCell.getValue();
    console.info("Previous state version: " + versionNumber);
    return Number(versionNumber || initialStateVersion);
}

function saveLastStateVersion(versionNumber) {
    console.info("Updating state version: " + versionNumber);
    return svCell.setValue(versionNumber);
}

function saveMaxStateVersion(versionNumber) {
    return maxSvCell.setValue(versionNumber);
}

function getMaxStateVersion() {
    let versionNumber = maxSvCell.getValue();
    return Number(versionNumber || 0);
}

function getPreviousMessages() {
    // Row is: [Chat ID, Message ID, Validator, Epoch, Round, MissedCount]
    return messagesRange.getValues();
}

function savePreviousMessages(data) {
    data.sort((a, b) => b[3] - a[3]); // sort by epoch descending
    data = data.slice(0, MESSAGES_TO_STORE);
    messagesRange.setValues(data);
}

/* * */


/* Track subscriptions in the spreadsheet */
const sLock = LockService.getScriptLock();
function getSubscriptionsSheet() {
    let sheet = ss.getSheetByName('subscriptions');

    // Create the sheet if it doesn't exist
    if (!sheet) {
        // ['Chat ID', 'Validator', 'User ID', 'Username']
        sheet = ss.insertSheet('subscriptions');
    }
    return sheet;
}

function updateSubscriptions(callbackFn) { // callbackFn accepts data[][] and returns [data, updated]
    const start = new Date().getTime();
    sLock.waitLock(30000);
    log("Waited for updateSubscriptions:" + (new Date().getTime() - start));
    try {
        let sheet = getSubscriptionsSheet();
        let oldData = sheet.getDataRange().getValues();
        // fix empty sheet
        if (oldData.length === 1 && oldData[0].length !== 4) {
            oldData = [];
        }
        const [data, updated] = callbackFn(oldData);
        if (updated) {
            sheet.clear();
            if (data.length > 0) {
                let range = sheet.getRange(1, 1, data.length, data[0].length);
                range.setValues(data);
            }
        }
    } finally {
        sLock.releaseLock();
    }
}

function getSubscriptions(validator) { // returns rows grouped by chat id
    const start = new Date().getTime();
    sLock.waitLock(30000);
    log("Waited for getSubscriptions:" + (new Date().getTime() - start));
    let subscriptions = {};
    try {
        let sheet = getSubscriptionsSheet();
        const data = sheet.getDataRange().getValues();
        for (const row of data) {
            if (row[1] === 'all' || row[1] === validator) {
                const chatId = row[0];
                let key = String(chatId);
                let chatSubs = subscriptions[key];
                if (!chatSubs){
                    chatSubs = [];
                    subscriptions[key] = chatSubs;
                }
                chatSubs.push(row);
            }
        }
    } finally {
        sLock.releaseLock();
    }
    return subscriptions;
}

/* * */

/* Tracking Validator Set */

/** The list of active validators extracted from the Epoch Change transaction */
let CACHED_VALIDATORS = [];
/** Epoch in which it was extracted */
let CACHED_EPOCH = 0;

function getValidator(epoch, idx) {
    if (CACHED_EPOCH !== epoch) {
        doLoadValidators(epoch);
    }
    return CACHED_VALIDATORS[idx];
}

function doLoadValidators(epoch) {
    try {
        const transactionData = callGateway('/stream/transactions', {
            limit_per_page: 1,
            kind_filter: "EpochChange",
            opt_ins: {
                receipt_output: false
            },
            at_ledger_state: {
                epoch: epoch,
            },
            order: "Desc"
        });
        updateValidators(transactionData.items[0], epoch);
        return;
    } catch (error) {
        console.error('Error fetching transactions:', error);
    }
    // Failed - do something
    CACHED_VALIDATORS = [];
    CACHED_EPOCH = 0;
}

function updateValidators(epochChangeTx, epoch) {
    let nextEpoch = epochChangeTx.receipt?.next_epoch;
    if (nextEpoch && (!epoch || nextEpoch.epoch === epoch) && epochChangeTx.fee_paid === '0') {
        CACHED_VALIDATORS = nextEpoch.validators.map((v) => v.address);
        CACHED_EPOCH = nextEpoch.epoch;
    } else {
        console.error('Not a valid EpochChange: ' + epoch);
        console.error(epochChangeTx);
    }
}

/* * */


/* Caching validator name */
CACHED_VALIDATOR_NAMES = {};

function getValidatorName(address) {
    let name = CACHED_VALIDATOR_NAMES[address];
    if (!name) {
        name = loadValidatorName(address);
        CACHED_VALIDATOR_NAMES[address] = name;
    }
    return name;
}

function loadValidatorName(address) {
    try {
        const transactionData = callGateway('/state/entity/details', {
            addresses: [address]
        });
        for (const item of transactionData.items[0].metadata.items) {
            if (item.key === 'name') {
                return item.value.typed.value;
            }
        }
    } catch (error) {
        console.error('Error fetching transactions:', error);
    }
    // not found anything - return something
    return "validator..." + address.substring(60);
}

/* * */

/* Gateway API */
function callGateway(path, payload) {
    const apiUrl = "https://gateway.radix.live";
    const response = UrlFetchApp.fetch(apiUrl + path, {
        'method': 'post',
        'contentType': 'application/json',
        'payload': JSON.stringify(payload)
    });

    const code = response.getResponseCode();
    if (code === 200) {
        return JSON.parse(response.getContentText());
    } else {
        console.error(`Failed to load: ${path}. ResponseCode: ${code}.`);
    }

}

/* * */


/* Time util */
function timeAgo(timestamp) {
    const diff = new Date().getTime() - timestamp;
    if (diff < 30000) {
        return "";
    }
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) {
        return pluralize(seconds, " second", " seconds") + " ago";
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return pluralize(minutes, " minute", " minutes") + " ago";
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return pluralize(hours, " hour", " hours") + " ago";
    }
    const days = Math.floor(hours / 24);
    return pluralize(days, " day", " days") + " ago";
}

function pluralize(num, singular, plural) {
    return String(num) + (isPlural(num) ? plural : singular);
}

function isPlural(num) {
    return num !== 1;
}

/* * */


/* Bot messaging - handleIncomingMessage() is executed as Telegram Webhook */
const Command = {
   HELP: 1,
   SUBSCRIBE: 2,
   UNSUBSCRIBE: 3,
   UNKNOWN: 9,
};
const ALL = 'all';
class IncomingMessage {
    constructor(command, validators, message, sender, chatId, quote) {
        this.command = command;
        this.validators = validators; // array of strings
        this.message = message;
        this.sender = sender; // User object
        this.chatId = chatId;
        this.quote = quote;
    }

    static parse(message) {
        const text = message.text;
        const chatId = message.chat.id;
        const parts = text.split(' ');
        // command always comes first
        const rawCommand = IncomingMessage.getRawCommand(parts[0]);
        let command = IncomingMessage.getCommand(rawCommand);

        let quote = null;
        let validators = [];
        let allValidators = rawCommand.endsWith('_all');
        for (let i = 1; i < parts.length; i++) {
            const validator = parts[i].toLowerCase();
            if (validator.startsWith('validator_')) {
                if (validators.indexOf(validator) === -1) {
                    validators.push(validator);
                }
            } else if (validator === ALL) {
                allValidators = true;
                break;
            } else {
                command = Command.UNKNOWN;
                quote = parts[i];
                break;
            }
        }
        if (allValidators) {
            validators = ['all'];
        }

        return new IncomingMessage(command, validators, message, message.from, chatId, quote);
    }

    static getRawCommand(part) {
        let commandCandidate = part.replaceAll('@' + BOT_NAME, '');
        if (commandCandidate.startsWith('/')) {
            commandCandidate = commandCandidate.substring(1);
        }
        return commandCandidate.toLowerCase();
    }

    static getCommand(rawCommand) {
        switch (rawCommand) {
            case 'start':
            case 'help':
            case 'h':
                return Command.HELP;
            case 'subscribe_all':
            case 'subscribe':
            case 'sub':
            case 's':
                return Command.SUBSCRIBE;
            case 'unsubscribe_all':
            case 'unsubscribe':
            case 'uns':
            case 'un':
                return Command.UNSUBSCRIBE;
            default:
                return Command.UNKNOWN;
        }
    }
}
function handleIncomingMessage(e) {
    try {
        var contents = JSON.parse(e.postData.contents);
        log("contents:");
        log(contents);
        if (contents.message && contents.message.text) { // ignore "added to group" messages
            const message = IncomingMessage.parse(contents.message);
            log(message);
            const command = message.command;
            switch (command) {
                case Command.UNKNOWN:
                    sendReplyMessage(message.message, message.quote, "Can't parse command. Please get /help");
                    break;
                case Command.HELP:
                    let msg= "Available commands:"
                    msg += "\nSubscribe to missed proposals for validator(s):";
                    msg += "\n    /subscribe &lt;address(es)&gt; | all";
                    msg += "\n    /subscribe_all";
                    msg += "\n  I will @ you if you subscribe in a TG group, or DM if you subscribe to me directly.";
                    msg += "\nTo unsubscribe <b>in this conversation</b> use:";
                    // &lt; and &gt; can't be mixed with tags inside double-quoted strings for some reason!
                    msg += "\n    /unsubscribe &lt;address(es)&gt; | all";
                    msg += "\n    /unsubscribe_all";
                    sendMessage(message.chatId, msg);
                    break;
                case Command.SUBSCRIBE:
                    if (message.validators.length === 0) {
                        respondTo(message.message, "Please specify validator addresses or `all`");
                    } else {
                        const subscribed = doSubscribe(message);
                        if (subscribed.length) {
                            respondTo(message.message, "Subscribed to validators: " + subscribed);
                        } else {
                            respondTo(message.message, "Already subscribed.");
                        }
                    }
                    break;
                case Command.UNSUBSCRIBE:
                    if (message.validators.length === 0) {
                        respondTo(message.message, "Please specify validator addresses or `all`");
                    } else {
                        const unsubscribed = doUnsubscribe(message);
                        if (unsubscribed) {
                            respondTo(message.message, "Unsubscribed from validators: " + message.validators);
                        } else {
                            respondTo(message.message, "Weren't subscribed.");
                        }
                    }
                    break;
            }
        }
    } catch(e){
        log(e);
    }
}
function doSubscribe(message) {
    const chatId = message.chatId;
    const userId = message.message.from.id;
    const userName = message.message.from.username;
    const validators = message.validators;

    // ['Chat ID', 'Validator', 'User ID', 'Username']
    updateSubscriptions((data) => {
        let updated = false;
        // 1. remove duplicates
        for (let i = 0; i < data.length; i++) {
            if (validators.length === 0) { // all validators were already present
                break;
            }
            const row = data[i];
            // noinspection EqualityComparisonWithCoercionJS
            if (row[0] == chatId && row[2] == userId) {
                if (validators[0] === 'all') { // change subscription to ALL validators
                    if (row[1] === 'all') { // already subscribed
                        validators.splice(0, 1);
                    } else {
                        updated = true;
                        data.splice(i, 1); // remove sub for a specific validator
                    }
                } else {
                    let validatorIdx = validators.indexOf(row[1]);
                    if (validatorIdx > -1 || row[1] === 'all') {
                        // already subscribed - remove from the list
                        validators.splice(validatorIdx, 1);
                    }
                }
            }
        }

        // 2. for all validators that were not in the list - add subscription(s)
        for (const validator of validators) {
            updated = true;
            data.push([chatId, validator, userId, userName]);
        }
        return [data, updated];
    });

    return validators;
}
function doUnsubscribe(message) {
    const chatId = message.chatId;
    const userId = message.message.from.id;
    const validators = message.validators;

    let updated = false;
    // ['Chat ID', 'Validator', 'User ID', 'Username']
    updateSubscriptions((data) => {
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            // noinspection EqualityComparisonWithCoercionJS
            if (row[0] == chatId && row[2] == userId) {
                if (validators[0] === 'all' || validators.indexOf(row[1]) > -1) { // remove ALL validators
                    updated = true;
                    data.splice(i, 1); // remove sub for a specific validator
                    i--;
                }
            }
        }
        return [data, updated];
    });

    return updated;
}
/* * */

/* Logging inside the Google Appscript App is tricky */
let logIdx = 1;
let clearedLog = false;
function log(message) {
    let sheet = ss.getSheetByName('last_state_version');
    if (!clearedLog) {
        clearedLog = true;
        sheet.getRange("I1:I100").setValue("");
    }
    let s = String(message);
    if (s === '[object Object]') {
        s = JSON.stringify(message);
    }
    sheet.getRange("I" + logIdx).setValue(s);
    logIdx++;
    Logger.info(message);
}
/* * */

// sends the message to Telegram APIs, OR just prints it if we are just testing with `doDebug()`.
function sendTelegramMessage(url, data) {
    if (data && data.payload && String(data.payload.chat_id) === "-1") {
        Logger.info("sendTelegramMessage: " + JSON.stringify(data, null, 2));
        return -1;
    } else {
        const response = UrlFetchApp.fetch(telegramUrl + url, data);
        const responseData = JSON.parse(response.getContentText());
        return responseData.result.message_id;
    }
}

// reply in groups, or just send a message in DMs
function respondTo(original, text) {
    if (original.chat.id === original.from.id) {
        return sendMessage(original.chat.id, text);
    } else {
        return sendReplyMessage(original, null, text);
    }
}

function sendReplyMessage(original, quote, text) {
    const replyParams = {
        message_id: String(original.message_id),
        chat_id: String(original.chat.id)
    };
    if (quote) {
        replyParams.quote = quote;
    }
    return sendMessage(original.chat.id, text, replyParams);
}

function sendMessage(chatId, text, replyParams) {
    let data = {
        method: "post",
        payload: {
            method: "sendMessage",
            chat_id: String(chatId), // have no idea why this is necessary
            text: text,
            parse_mode: "HTML",
            reply_parameters: JSON.stringify(replyParams)
        }
    };
    return sendTelegramMessage('/sendMessage', data);
}

function editMessageText(chatId, messageId, text) {
    var data = {
        method: "post",
        payload: {
            method: "editMessageText",
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: "HTML",
        }
    };
    UrlFetchApp.fetch(telegramUrl + '/editMessageText', data);
}

/* * */


/* Transactions stuff */

// Gets the new events since the specified state version
function getNextEvents(prevStateVersion) {
    let stateVersion = prevStateVersion + 1;
    console.log('Current time:', new Date());

    let maxTransactionStateVersion = prevStateVersion;
    const events = [];
    try {
        const transactionData = callGateway('/stream/transactions', {
            limit_per_page: 100,
            kind_filter: "All",
            opt_ins: {
                receipt_state_changes: true,
                receipt_output: false
            },
            from_ledger_state: {
                state_version: Number(stateVersion),
            },
            order: "Asc"
        });
        if (transactionData.items.length) {
            maxTransactionStateVersion = transactionData.items[transactionData.items.length - 1].state_version;
        }
        saveMaxStateVersion(transactionData.ledger_state.state_version)

        for (const transaction of transactionData.items) {
            if (transaction.fee_paid === '0') { // round change or epoch change transaction
                if (transaction.receipt?.next_epoch) { // epoch change - need to process before the events!
                    updateValidators(transaction);
                }

                let updatedSubstates = transaction?.receipt?.state_updates?.updated_substates;
                if (updatedSubstates) {
                    for (const substate of updatedSubstates) {
                        let substateId = substate.substate_id;
                        if (substateId && substateId.entity_type === 'GlobalConsensusManager' &&
                            substateId.substate_type === 'ConsensusManagerFieldCurrentProposalStatistic') {
                            const previous = substate.previous_value.substate_data.value.missed;
                            const current = substate.new_value.substate_data.value.missed;
                            for (let i = 0; i < current.length; i++) {
                                if (current[i] > previous[i]) {
                                    let address = getValidator(transaction.epoch, i);
                                    events.push({
                                        validator: address,
                                        epoch: transaction.epoch,
                                        round: transaction.round,
                                        timestamp: new Date(transaction.round_timestamp).getTime(),
                                        validatorName: getValidatorName(address)
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error fetching transactions:', error);
    }
    return [maxTransactionStateVersion, events];
}


async function pollTransactions(isDebug, stateVersionOverride) {
    const stateVersion = stateVersionOverride || getLastStateVersion();
    const [newStateVersion, events] = getNextEvents(stateVersion);

    if (events.length) {
        let data = getPreviousMessages();
        for (const event of events) {
            const mainChat = isDebug ? TEST_CHAT_ID : CHAT_ID;
            let subscriptionsMap = getSubscriptions(event.validator);
            console.log("subscriptionsMap");
            console.log(subscriptionsMap);
            if (!subscriptionsMap[mainChat]) {
                subscriptionsMap[mainChat] = [];
            }
            if (isDebug) { // do not send to other chats
                const s = subscriptionsMap[mainChat];
                subscriptionsMap = {};
                subscriptionsMap[mainChat] = s;
            }
            for (const chatId in subscriptionsMap) {
                console.log("Processing for chatId: " + chatId);
                const usersToTag = getUsersToTag(subscriptionsMap[chatId]);
                console.log(usersToTag);

                // Row is: [Chat ID, Message ID, Validator, Epoch, Round, MissedCount]
                // noinspection EqualityComparisonWithCoercionJS
                const previousMessage = data.find(row => row[0] == chatId && row[2] == event.validator && row[3] == event.epoch);
                if (previousMessage) {
                    console.log("Found previous message:");
                    console.log(previousMessage);
                    previousMessage[5]++; // +1 missed proposal

                    const message = await formatMessage(event, usersToTag, previousMessage);
                    await editMessageText(chatId, previousMessage[1], message);
                } else {
                    const message = await formatMessage(event, usersToTag);
                    const messageId = await sendMessage(chatId, message);
                    data.push([chatId, messageId, event.validator, event.epoch, event.round, 1]);
                }
            }

        }
        savePreviousMessages(data);
    }

    // Save the latest state version after processing
    if (!stateVersionOverride && stateVersion !== newStateVersion) {
        saveLastStateVersion(newStateVersion);
    }
}

function getUsersToTag(subscriptions) {
    const usersToTag = [];
    if (subscriptions && subscriptions.length) {
        for (const sub of subscriptions) {
            if (sub[0] !== sub[2]) { // Group, not a DM
                if (sub[3]) { // empty username - don't tag
                    usersToTag.push('@' + sub[3]);
                }
            }
        }
    }
    return usersToTag;
}

async function formatMessage(event, usersToTag, missData) {
    const missedCount = missData ? missData[5] : 1;
    var result = `<a href="https://validators.stakesafe.net/?validator=${event.validator}">${event.validatorName}</a> \n`;
    result += `missed ${pluralize(missedCount, ' proposal', ' proposals')} in Epoch ${event.epoch}`;
    if (missData) {
        result += ` Rounds ${missData[4]}-${event.round}\n`;
    } else {
        result += ` Round ${event.round}\n`;
    }
    const age = timeAgo(event.timestamp);
    if (age) {
        result += `                          (${age})\n`;
    }
    if (usersToTag.length) {
        result += `    cc ${usersToTag.join(' ')} \n`;
    }
    return result;
}


async function processingLoop() {
    let startTime = new Date().getTime();
    // ScriptApp.newTrigger() can be scheduled to run at most every minute.
    // Perform 60 iterations with up to 5 sec delay to process transactions exactly every 5 seconds
    const iterations = waitingTimeMs / POLL_INTERVAL;
    for (let i = 1; i <= iterations; i++) {
        await pollTransactions(false);
        if (i !== iterations) {
            const versionsBehind = getMaxStateVersion() - getLastStateVersion();
            const iterationEndTime = i * POLL_INTERVAL + startTime;
            const sleepTime = iterationEndTime - new Date().getTime()
            console.log(`${i} => sleeping for: ${sleepTime}, behind ${versionsBehind} versions.`);
            if (sleepTime > 0) {
                if (versionsBehind > 100) { // don't sleep if we're behind
                    // do one more iteration
                    i--;
                } else {
                    Utilities.sleep(sleepTime);
                }
            } else {
                const iterationsToSkip = Math.floor(-sleepTime / POLL_INTERVAL);
                if (iterationsToSkip > 0) {
                    i += iterationsToSkip;
                    console.log(`Skipped ${iterationsToSkip}. Next iteration: ${i + 1}`);
                }
            }
        }
    }
}


/******* Spreadsheet functions *******/

/** Installs the trigger, so the `processingLoop()` will run every minute */
function updateTriggers() {
    console.log("Starting main loop");
    // Deletes all triggers in the current project.
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
        ScriptApp.deleteTrigger(triggers[i]);
    }

    // Adds a new trigger
    let interval = waitingTime / 60;
    ScriptApp.newTrigger('processingLoop')
        .timeBased()
        .everyMinutes(interval)
        .create();
}
/** Need to execute with an updated APP url after the deployment. (just once) */
function updateWebhook() {
    const response = UrlFetchApp.fetch(`${telegramUrl}/setWebhook?url=${WEBAPP_URL}`);
    console.log(response.getContentText());
}

/** Webapp (Spreadsheet script) entry point */
function doPost(request) {
    handleIncomingMessage(request);
}


/** Execute from the App Script Editor to test if everything works */
async function doDebugPoll() {
    await pollTransactions(true, 185062200);
}
function doDebugSubscriptions() {
    let subscriptions = getSubscriptions('validator_rdx1s07zllgtzvy9xfyj34jfa9qpd004tcqg80c6vjezv5xmvk0d7jvcjm');
    console.log(subscriptions);
}
/** Run to execute a test request and print the result into the console */
function doDebugMessage() {
    // Simulate a test request
    const testMessage = {
        message: {
            chat: {
                //   id: "-1" // pass "-1" to simply log the data, don't send anywhere
                id: -1,// TEST_CHAT_ID,
            },
            text: "/help" // test command - modify if needed, e.g.: /subscribe all
        }
    };

    // Call the doPast function with the test message to simulate bot interaction
    return doPost({
        postData: {
            contents: JSON.stringify(testMessage)
        }
    });
}

