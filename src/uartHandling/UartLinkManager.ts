import SerialPort from 'serialport'
import {UartLink} from "./UartLink";
import {getSnapSerialList} from "./snapDiscovery";
import {CONFIG} from "../config/config";
import {Util} from "crownstone-core";
import {Logger} from "../Logger";
import {UartWrapperV2} from "./uartPackets/UartWrapperV2";
import {UartTransferOverhead} from "./containers/UartTransferOverhead";
import {UartTxType} from "../declarations/enums";
const log = Logger(__filename);

let UPDATE_PORTS;

if (CONFIG.useSearchById) {
  UPDATE_PORTS = function() {
    return getSnapSerialList()
  }
}
else {
  UPDATE_PORTS = function() {
    return new Promise((resolve, reject) => {
      let availablePorts = {};
      SerialPort.list().then((ports) => {
        ports.forEach((port) => {
          availablePorts[port.path] = {port: port, connected: false};
        });
        resolve(availablePorts);
      });
    })
  }
}

export class UartLinkManager {
  autoReconnect = false;

  transferOverhead: UartTransferOverhead;
  port : UartLink = null;
  connected = false;
  triedPorts = [];

  heartBeatInterval = null;
  forcedPort = null;

  constructor(autoReconnect, transferOverhead: UartTransferOverhead) {
    this.transferOverhead = transferOverhead;
    this.autoReconnect = autoReconnect;
  }

  start(forcedPort = null) : Promise<void> {
    this.forcedPort = forcedPort;
    return this.initiateConnection();
  }

  async restart() : Promise<void> {
    this.connected = false;
    clearInterval(this.heartBeatInterval);

    if (this.autoReconnect) {
      this.port = null;
      this.triedPorts = [];
      await Util.wait(100);
      return this.initiateConnection();
    }
  }

  close() : Promise<void> {
    clearInterval(this.heartBeatInterval);
    return this.port.destroy();
  }



  initiateConnection() : Promise<void> {
    clearInterval(this.heartBeatInterval);
    let promise;
    if (this.forcedPort) {
      promise = this.tryConnectingToPort(this.forcedPort);
    }
    else {
      promise = UPDATE_PORTS()
        .then((available) => {
          log.info("Available ports on the system", available);
          let ports = available;
          let portIds = Object.keys(ports);
          return Util.promiseBatchPerformer(portIds, (portId) => {
            // we found a match. Do not try further
            if (this.connected) { return Promise.resolve(); }

            let port = ports[portId].port?.path || portId;

            if (CONFIG.useManufacturer === false || CONFIG.useSearchById) {
              if (this.triedPorts.indexOf(port) === -1) {
                return this.tryConnectingToPort(port);
              }
            }
            else {
              let manufacturer = ports[portId].port?.manufacturer;
              // we use indexOf to check if a part of this string is in the manufacturer. It can possibly differ between platforms.
              if (manufacturer && (manufacturer.indexOf("Silicon Lab") !== -1 || manufacturer.indexOf("SEGGER") !== -1)) {
                if (this.triedPorts.indexOf(port) === -1) {
                  return this.tryConnectingToPort(port);
                }
              }
            }
            return Promise.resolve();
          })
        })
        .then(() => {
          // Handle the case where none of the connected devices match.
          if (this.port === null) {
            log.info("Could not find a Crownstone USB connected.");
            throw "COULD_NOT_OPEN_CONNECTION_TO_UART";
          }
        })
    }

    return promise.catch((err) => {
      log.info("initiateConnection error", err)
      this.triedPorts = [];
      if (this.autoReconnect) {
        return new Promise((resolve, reject) => {
          setTimeout(() => { resolve(); }, 500);
        })
          .then(() => {
            return this.initiateConnection();
          })
      }
      else {
        throw err;
      }
    })
  }

  tryConnectingToPort(port)  : Promise<void> {
    return new Promise((resolve, reject) => {
      this.connected = false;
      log.info("Trying port", port);
      this.triedPorts.push(port);
      let link = new UartLink(() => { this.restart(); }, this.transferOverhead);
      link.tryConnectingToPort(port)
        .then(() => {
          log.info("Successful connection to ", port);
          this.port = link;
          this.connected = true;
          this.heartBeatInterval = setInterval(() => { this.heartBeat()}, 2000);
          resolve();
        })
        .catch((err) => {
          clearInterval(this.heartBeatInterval);
          log.info("Failed connection", port, err);
          reject(err);
        })
    })
  }


  async heartBeat() {
    let timeout = Buffer.alloc(2); timeout.writeUInt16LE(4,0);
    await this.write(new UartWrapperV2(UartTxType.HEARTBEAT, timeout));
  }

  async write(uartMessage: UartWrapperV2) {
    // handle encryption here.
    uartMessage.setDeviceId(this.transferOverhead.deviceId)
    if (this.transferOverhead.encryption.key !== null) {
      // ENCRYPT
      log.verbose("Encrypting packet...", uartMessage.getPacket())
      let packet = uartMessage.getEncryptedPacket(
        this.transferOverhead.encryption.outgoingSessionData,
        this.transferOverhead.encryption.key
      );
      return this.port.write(packet).catch();
    }
    else {
      return this.port.write(uartMessage.getPacket()).catch();
    }
  }

}