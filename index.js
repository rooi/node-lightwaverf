var util = require('util');
var events = require('events');
var dgram = require('dgram');
var https = require('https');
var querystring = require('querystring');
var fs = require('fs');
var wait = require('wait.for');
var yaml = require('js-yaml');
var rp = require('request-promise');
const { timeStamp } = require('console');
var debug = require('debug')('lightwaverf');

/**
 * LightwaveRF API
 *
 * @param object config The config
 *
 * An instance of the LightwaveRF API
 */
function LightwaveRF(config, callback) {
    if (!(this instanceof LightwaveRF)) {
        return new LightwaveRF(config, callback);
    }

    const self = this;
    this.timeout = config.timeout || 1000;
    this.queue = [];
    this.ready = true;

    this.currentTransactionNumber = 0;

    this.devices = [];//[{roomId:0,roomName:'',
    //deviceId:0,deviceName:'',
    //deviceType:''}];

    events.EventEmitter.call(this);

    this.setMaxListeners(255);

    //Counter
    this.messageCounter = 0;

    //Config
    this.config = config;

    // Use broadcast to discover the IP
    this.config.ip = this.config.ip || '255.255.255.255';

    //Response listeners
    this.responseListeners = {};

    //Send Socket
    this.sendSocket = dgram.createSocket("udp4");

    //Receive socket
    this.receiveSocket = dgram.createSocket("udp4");

    //Receive message
    this.receiveSocket.on("message", function (message, rinfo) {
        // If we were using broadcast IP, we have now
        // discovered Link device IP and can switch off
        // broadcast
        if (this.config.ip == '255.255.255.255') {
            console.log("We have now discovered Link IP address: %s", rinfo.address);
            this.config.ip = rinfo.address
            this.sendSocket.setBroadcast(false)
        }

        //Check this came from the lightwave unit
        if (rinfo.address !== this.config.ip) {
            //Came from wrong ip]
            console.warn("Response came from a different IP than our configured", rinfo.address, this.config.ip)
            return false;
        }

        const parseResponse = (buffer) => {
            const response = {}
            const message = buffer.toString('utf-8');
            if (message.match(/^\*!/)) {
                const jsonResponse = JSON.parse(message.replace(/^\*!/, ''))
                self.currentTransactionNumber = jsonResponse.trans + 1;

                Object.assign(response, jsonResponse)
            } else {
                //Split off the code for the message
                var parts = message.split(",");
                var trans = parts.splice(0, 1);
                var content = parts.join(",").replace(/(\r\n|\n|\r)/gm, "");
                response.trans = parseInt(trans);
                response.message = content;
            }

            return response;
        }

        let linkResponse = parseResponse(message)
        debug(">>>>>>>> Received response msg: %s, rinfo: %s", message, linkResponse);

        var responseListenerData = this.responseListeners[linkResponse.trans];
        if (!responseListenerData) {
            debug("We haven't got anyone to respond to, ignoring the message")
            return;
        }

        responseListenerData.listener(
            linkResponse.trans,
            linkResponse.fn,
            linkResponse.error ? linkResponse.error : null
        );

        delete this.responseListeners[linkResponse.trans];

    }.bind(this));

    this.receiveSocket.on("listening", function () {
        var address = this.receiveSocket.address();
        debug("Receiver socket listening " + address.address + ":" + address.port);

        self.send('@H', (code, err) => {
            if (err) {
                console.log(code, err)
            }

            self.initialiseConfiguration(callback);
        })
    }.bind(this));

    this.sendSocket.bind();
    //Bind to the receive port
    this.receiveSocket.bind(9761);
}
util.inherits(LightwaveRF, events.EventEmitter);

LightwaveRF.prototype.initialiseConfiguration = function (callback) {
    if (this.config.file) {
        this.getFileConfiguration(this.config.file, callback);
    } else {
        debug("Not using `config.file`")
        //Check config
        if (!this.config.host) {
            this.config.host = "web.trustsmartcloud.com"
        }

        if (!this.config.email || !this.config.pin) {
            console.log("No email or pin specified. The server configuration (rooms, devices, etc.) cannot be obtained")
        }
        else {
            this.getConfiguration(this.config.email, this.config.pin, this.config.host, callback)
        }
    }

}

/**
 * Register this device with the Wi-Fi Link
 *
 * @param Function callback The callback function
 *
 * @return void
 */
LightwaveRF.prototype.register = function (callback) {
    this.sendUdp("!R1Fa", callback);
}

/**
 * Request energy
 *
 * @param Function callback The callback function
 *
 * @return void
 */
LightwaveRF.prototype.requestEnergy = function (callback) {
    this.sendUdp("@?\0", function (error, content) {
        if (error) {
            //Send error back
            callback(error);
        } else {
            //Determine if this is the energy monitor
            //ID,?W=current,max,today,yesterday (all kwh)
            var values = content.substring(3).split(",");
            callback(undefined, {
                current: parseInt(values[0], 10),
                max: parseInt(values[1], 10),
                today: parseInt(values[2], 10),
                yesterday: parseInt(values[3], 10)
            });
        }
    });
}

/**
 * Turn a device off
 *
 * @param integer  roomId   The room ID
 * @param integer  deviceId The device ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.turnDeviceOff = function (roomId, deviceId, callback) {
    var state = "0";
    this.exec("!R" + roomId + "D" + deviceId + "F" + state + "|\0", callback);
}

/**
 * Turn a device on
 * 
 * @param integer  roomId   The room ID
 * @param integer  deviceId The device ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.turnDeviceOn = function (roomId, deviceId, callback) {
    var state = "1";
    this.exec("!R" + roomId + "D" + deviceId + "F" + state + "|\0", callback);
}

/**
 * Open a device
 *
 * @param integer  roomId   The room ID
 * @param integer  deviceId The device ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.openDevice = function (roomId, deviceId, callback) {
    var state = ">";
    this.exec("!R" + roomId + "D" + deviceId + "F" + state + "|\0", callback);
}

/**
 * Close a device
 *
 * @param integer  roomId   The room ID
 * @param integer  deviceId The device ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.closeDevice = function (roomId, deviceId, callback) {
    var state = "<";
    this.exec("!R" + roomId + "D" + deviceId + "F" + state + "|\0", callback);
}

/**
 * Stop a device
 *
 * @param integer  roomId   The room ID
 * @param integer  deviceId The device ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.stopDevice = function (roomId, deviceId, callback) {
    var state = "^";
    this.exec("!R" + roomId + "D" + deviceId + "F" + state + "|\0", callback);
}

/**
 * Turn all devices in a room off
 *
 * @param integer  roomId   The room ID
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.turnRoomOff = function (roomId, callback) {
    this.exec("!R" + roomId + "Fa\0", callback);
}

/**
 * Set the dim percentage of a device
 *
 * @param integer  roomId        The room ID
 * @param integer  deviceId      The device ID
 * @param integer  dimPercentage The percentage to set the device dim
 * @param Function callback      The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.setDeviceDim = function (roomId, deviceId, dimPercentage, callback) {
    var dimAmount = parseInt(dimPercentage * 0.32, 10); //Dim is on a scale from 0 to 32

    if (dimAmount === 0) {
        this.turnDeviceOff(roomId, deviceId, callback);
    } else {
        this.exec("!R" + roomId + "D" + deviceId + "FdP" + dimAmount + "|\0", callback);
    }
}

/**
 * Get message code
 *
 * @return string
 */
LightwaveRF.prototype.getTransactionNumber = function () {
    return this.currentTransactionNumber;
}


LightwaveRF.prototype.exec = function () {
    // Check if the queue has a reasonable size
    if (this.queue.length > 100) {
        this.queue.pop();
    }

    this.queue.push(arguments);
    this.process();
};

LightwaveRF.prototype.send = function (cmd, callback) {
    this.sendUdp(cmd, callback);
    //if (callback) callback();
};
/**
 * Send a message over udp
 *
 * @param string   message  The message to send
 * @param Function callback The callback for if there are any errors
 *
 * @return void
 */
LightwaveRF.prototype.sendUdp = function (message, callback) {
    //Add to message
    const transactionNumber = this.getTransactionNumber();

    //Prepend code to message
    message = transactionNumber + "," + message;

    debug(`[${this.config.ip}] Sending message: ${message}`);

    //Create buffer from message
    const messageBuffer = Buffer.from(message, 'utf-8');

    this.sendSocket.setBroadcast(true);

    //Broadcast the message
    this.sendSocket.send(messageBuffer, 0, messageBuffer.length, 9760, this.config.ip);

    //Add listener
    if (callback) {
        this.responseListeners[transactionNumber] = {
            time: new Date().getTime(),
            listener: callback
        };

        // Expire request, trigger retry
        setTimeout(() => {
            const listener = this.responseListeners[transactionNumber];
            if (listener) {
                debug("The listener is still there, triggering error");
                delete this.responseListeners[transactionNumber];
                callback(listenerKey, undefined, "ERR:EXPIRED");
            }
        }, 1000);
    }
}

LightwaveRF.prototype.process = function () {
    if (this.queue.length === 0) return;
    if (!this.ready) return;
    var self = this;
    this.ready = false;
    this.send.apply(this, this.queue.shift());
    setTimeout(function () {
        self.ready = true;
        self.process();
    }, this.timeout);
};


/**
 * Parser to get de devices from https POST
 */
LightwaveRF.prototype.getDevices = function (roomsString, devicesString, typesString, callback) {

    var nrRooms = 8;
    var nrDevicesPerRoom = 10;

    var tempRS = roomsString;
    var tempDS = devicesString;
    var tempTS = typesString;
    var deviceCounter = 0;
    for (var i = 0; i < nrRooms; i++) {
        var rId = i + 1;

        tempRS = tempRS.substring(tempRS.indexOf('\"') + 1);
        var rName = tempRS.substring(0, tempRS.indexOf('\"'));
        tempRS = tempRS.substring(tempRS.indexOf('\"') + 1);
        //console.log("room=" + rName);

        for (var j = 0; j < nrDevicesPerRoom; j++) {
            var dId = j + 1;

            tempDS = tempDS.substring(tempDS.indexOf('\"') + 1);
            var dName = tempDS.substring(0, tempDS.indexOf('\"'));
            tempDS = tempDS.substring(tempDS.indexOf('\"') + 1);
            //console.log("devices=" + dName);

            tempTS = tempTS.substring(tempTS.indexOf('\"') + 1);
            var dType = tempTS.substring(0, tempTS.indexOf('\"'));
            tempTS = tempTS.substring(tempTS.indexOf('\"') + 1);
            //console.log("devices=" + deviceName + " type=" + dType);

            // Get device types
            //   O: On/Off Switch
            //   D: Dimmer
            //   R: Radiator(s)
            //   P: Open/Close
            //   I: Inactive (i.e. not configured)
            //   m: Mood (inactive)
            //   M: Mood (active)
            //   o: All Off
            if (dType == "O" || dType == "D") {
                this.devices.push({
                    roomId: rId, roomName: rName,
                    deviceId: dId, deviceName: dName,
                    deviceType: dType
                });
                //console.log("devices=" + deviceName + " type=" + deviceType);
                deviceCounter += 1;
            }
        }
    }

    if (callback) callback(this.devices, this);

    //console.log(this.devices);
}

/**
 * Read configuration from a lightwaverf Gem YAML file
 */
LightwaveRF.prototype.getFileConfiguration = function (file, callback) {
    try {
        var that = this,
            yamlConfig = yaml.safeLoad(fs.readFileSync(file, 'utf8'));

        yamlConfig['room'].forEach(function (room, roomIndex) {
            room['device'].
                filter(function (device) {
                    return device['type'] == 'O' || device['type'] == 'D';
                }).
                forEach(function (device, deviceIndex) {
                    that.devices.push({
                        roomId: room['id'] ? parseInt(room['id'].substring(1)) : roomIndex + 1,
                        roomName: room['name'],
                        deviceId: device['id'] ? parseInt(device['id'].substring(1)) : deviceIndex + 1,
                        deviceName: device['name'],
                        deviceType: device['type']
                    });
                });
        });

        if (callback) {
            callback(that.devices, that);
        }

        //console.log(that.devices);

    } catch (e) {
        console.log('Unable to read YAML file ' + file);
        console.log(e);
    }
};

LightwaveRF.prototype.parseRooms = function (lightwaveResponse, callback) {
    debug('Parsing lightwaveResponse: ',
        lightwaveResponse.content.estates[0].locations[0].zones[0].rooms[0].devices);

    var home = lightwaveResponse.content.estates[0].locations[0].zones[0];

    for (var i = 0; i < home.rooms.length; i++) {
        var r = home.rooms[i];

        debug("Room " + r.name + " with " + r.devices.length + " devices");

        // Get device types
        //   O: On/Off Switch
        //   D: Dimmer
        //   R: Radiator(s)
        //   P: Open/Close
        //   I: Inactive (i.e. not configured)
        //   m: Mood (inactive)
        //   M: Mood (active)
        //   o: All Off
        var deviceTypeMapping = {
            1: 'L',
            2: 'D',
            3: 'P'
        }

        for (var j = 0; j < r.devices.length; j++) {
            var d = r.devices[j];

            this.devices.push({
                roomId: r.room_number,
                roomName: r.name,
                deviceId: d.device_number,
                deviceName: d.name,
                deviceType: deviceTypeMapping[d.device_type_id]
            });
        }
    }

    debug('Devices:', this.devices)

    callback(this.devices, this);
};

/**
 * Connect to the server and obtain the configuration
 */
LightwaveRF.prototype.getConfiguration = function (email, pin, manager_host, callback) {
    // An object of options to indicate where to post to

    debug('Getting rooms from LightWave');
    var self = this;
    var host = 'https://control-api.lightwaverf.com';
    var json = rp.defaults({
        json: true
    });
    var auth, token;
    json.get(host + '/v1/user?password=' + pin + '&username=' + email)
        .then(function (res) {
            return json.get(host + '/v1/auth?application_key=' + res.application_key)
        })
        .then(function (res) {
            token = res.token;
            auth = json.defaults({
                headers: {
                    'X-LWRF-token': token,
                    'X-LWRF-platform': 'ios',
                    'X-LWRF-skin': 'lightwaverf'
                }
            });

            return auth.get(host + '/v1/device_type?nested=1');
        })
        .then(function (res) {
            debug(res);
            return auth.get(host + '/v1/user_profile?nested=1')
        })
        .then(function (res) {
            self.parseRooms(res, callback);
        });
}

module.exports = LightwaveRF;
