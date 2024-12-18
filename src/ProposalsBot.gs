/**
 * Also create a file `secrets.gs` with your bot token:
 function getBotToken() {
 return '<the token>';
 }
 */

const botToken = getBotToken();  // add your bot Token
const CHAT_ID = '-1002298175976';  // the real group
const TEST_CHAT_ID = '-1002298175976'; // set to "-1" to simply log messages
const initialStateVersion = '185041900'; // Starting point for this Spreadsheet

var telegramUrl = "https://api.telegram.org/bot" + botToken;


const waitingTime = 300; // can be 1 or 5 minutes
const waitingTimeMs = waitingTime * 1000;


const ss = SpreadsheetApp.getActiveSpreadsheet();
//

// Stores the last processed state version in cell A2, Max seen version in cell B2
const [svCell, maxSvCell, messagesRange] = getStateVersionStorage();

/* State version stuff */
function getStateVersionStorage() {
    let sheet = ss.getSheetByName('last_state_version');

    // Create the sheet if it doesn't exist
    if (!sheet) {
        sheet = ss.insertSheet('last_state_version');
        sheet.appendRow(['State Version', 'Max Seen Version']);

        sheet.getRange("A9:F9").merge().setHorizontalAlignment('center').setValue("Last 100 messages");
        sheet.getRange("A10").setValue("Chat ID");
        sheet.getRange("B10").setValue("Message ID");
        sheet.getRange("C10").setValue("Validator");
        sheet.getRange("D10").setValue("Epoch");
        sheet.getRange("E10").setValue("Round");
        sheet.getRange("F10").setValue("MissedCount");
    }

    return [sheet.getRange("A2"), sheet.getRange("B2"), sheet.getRange("A11:F30")];
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
    var data = messagesRange.getValues();
    return data;
}

function savePreviousMessages(data) {
    console.log(data);
    data.sort((a, b) => b[3] - a[3]); // sort by epoch descending
    data = data.slice(0, 20)
    console.log(data);

    messagesRange.setValues(data);
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
    if (diff < 2000) {
        return "moments ago";
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


/* * */

// sends the message to Telegram APIs, OR just prints it if we are just testing with `doDebug()`.
function sendTelegramMessage(url, data) {
    if (data && data.payload && data.payload.chat_id == "-1") {
        Logger.info("sendTelegramMessage: " + JSON.stringify(data, null, 2));
        return -1;
    } else {
        const response = UrlFetchApp.fetch(telegramUrl + url, data);
        const responseData = JSON.parse(response.getContentText());
        return responseData.result.message_id;
    }
}

function sendMessage(chatId, text) {
    var data = {
        method: "post",
        payload: {
            method: "sendMessage",
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
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

function sendGroupMessage(text, isDebug) {
    return sendMessage(isDebug ? TEST_CHAT_ID : CHAT_ID, text);
}

function sendChatMessage(chatId, text) {
    return sendMessage(chatId, text);
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
            const chatId = isDebug ? TEST_CHAT_ID : CHAT_ID;
            // Row is: [Chat ID, Message ID, Validator, Epoch, Round, MissedCount]
            const previousMessage = data.find(row => row[0] == chatId && row[2] == event.validator && row[3] == event.epoch);
            if (previousMessage) {
                console.log("Found previous message:");
                console.log(previousMessage);
                previousMessage[5]++; // +1 missed proposal

                const message = await formatMessage(event, previousMessage);
                await editMessageText(chatId, previousMessage[1], message);
            } else {
                const message = await formatMessage(event);
                const messageId = await sendGroupMessage(message, isDebug);
                data.push([chatId, messageId, event.validator, event.epoch, event.round, 1]);
            }
        }
        savePreviousMessages(data);
    }

    // Save the latest state version after processing
    if (!stateVersionOverride && stateVersion !== newStateVersion) {
        saveLastStateVersion(newStateVersion);
    }
}

async function formatMessage(event, missData) {
    const missedCount = missData ? missData[5] : 1;
    var result = `<a href="https://validators.stakesafe.net/?validator=${event.validator}">${event.validatorName}</a> \n`;
    result += `missed ${pluralize(missedCount, ' proposal', ' proposals')} in Epoch ${event.epoch}`;
    if (missData) {
        result += ` Rounds ${missData[4]}-${event.round}\n`;
    } else {
        result += ` Round ${event.round}\n`;
    }
    result += `                    (${timeAgo(event.timestamp)})\n`;
    // result += `    cc @Mleekko \n`;
    return result;
}


async function processingLoop() {
    let startTime = new Date().getTime();
    // ScriptApp.newTrigger() can be scheduled to run at most every minute.
    // Perform 60 iterations with up to 5 sec delay to process transactions exactly every 5 seconds
    const duration = 5000;
    const iterations = waitingTimeMs / duration;
    for (let i = 1; i <= iterations; i++) {
        await pollTransactions(false);
        if (i !== iterations) {
            const versionsBehind = getMaxStateVersion() - getLastStateVersion();
            const iterationEndTime = i * duration + startTime;
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
                const iterationsToSkip = Math.floor(-sleepTime / duration);
                if (iterationsToSkip > 0) {
                    i += iterationsToSkip;
                    console.log(`Skipped ${iterationsToSkip}. Next iteration: ${i + 1}`);
                }
            }
        }
    }
}

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

/* Execute from the App Script Editor to test if everything works */
async function doDebug() {
    await pollTransactions(true, 185062200);
}

