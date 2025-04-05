import { randomUUIDv7, type ServerWebSocket } from "bun";
import type { IncomingMessage, SignupIncomingMessage } from "../../packages/common/index";
import { prismaClient } from "db";
import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import nacl_util from "tweetnacl-util";
import bs58 from "bs58";
import "dotenv/config";




const COST_PER_VALIDATION = 100; 
const VALIDATION_INTERVAL = 60 * 1000; 
const PAYOUT_INTERVAL = 15 * 60 * 1000; 
const HEARTBEAT_TIMEOUT = 90 * 1000; 
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const availableValidators = [];
const CALLBACKS = {};
const activeWebsites = new Map(); 
let connection = null;
let payoutKeypair = null;

async function initializeSolana() {
  try {
    connection = new Connection(SOLANA_RPC_URL, "confirmed");
    const tokenPrivateKey = process.env.TOKEN_PRIVATE_KEY;
    if (tokenPrivateKey) {
      const secretKey = bs58.decode(tokenPrivateKey);
      payoutKeypair = Keypair.fromSecretKey(secretKey);
      
      const balance = await connection.getBalance(payoutKeypair.publicKey);
      console.log(`Payout wallet balance: ${balance / 1000000000} SOL`);
      
      if (balance < 10000000) {
        console.warn("WARNING: Low balance in payout wallet");
      }
    } else {
      console.warn("No TOKEN_PRIVATE_KEY provided. Payouts will be tracked but not executed");
    }
  } catch (error) {
    console.error("Error initializing Solana:", error);
  }
}

Bun.serve({
  fetch(req, server) {
    if (server.upgrade(req)) return;
    const url = new URL(req.url);
    
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        validators: availableValidators.length,
        websites: activeWebsites.size,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname === "/stats") {
      return new Response(JSON.stringify({
        validators: availableValidators.length,
        activeWebsites: activeWebsites.size,
        pendingCallbacks: Object.keys(CALLBACKS).length,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response("Not found", { status: 404 });
  },
  port: 8081,
  websocket: {
    async message(ws, message) {
      try {
        const data = JSON.parse(message);
        
    
        if (ws.data && ws.data.validatorId) {
          ws.data.lastActivity = Date.now();
        }
        
        switch (data.type) {
          case "signup":
            await handleSignup(ws, data.data);
            break;
            
          case "validate":
            await handleValidationResult(data);
            break;
            
          case "heartbeat":
            handleHeartbeat(ws, data.data);
            break;
            
          case "pong":
            break;
            
          case "shutdown":
            handleShutdown(ws, data.data);
            break;
            
          default:
            console.warn(`Unknown message type: ${data.type}`);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    },
    
    open(ws) {
      ws.data = { connectedAt: Date.now(), lastActivity: Date.now() };
      console.log(`New connection established`);
    },
    
    close(ws) {
      if (ws.data && ws.data.validatorId) {
        const index = availableValidators.findIndex(v => v.validatorId === ws.data.validatorId);
        if (index !== -1) {
          console.log(`Validator ${ws.data.validatorId} disconnected`);
          availableValidators.splice(index, 1);
        }
      }
    }
  }
});

async function handleSignup(ws, { ip, publicKey, signedMessage, callbackId, version, capabilities }) {
  try {
    console.log(`Processing signup from ${ip}, public key: ${publicKey}`);
    
    const verified = await verifyMessage(
      `Signed message for ${callbackId}, ${publicKey}`,
      publicKey,
      signedMessage
    );
    
    if (!verified) {
      console.warn(`Signature verification failed for ${publicKey}`);
      ws.send(JSON.stringify({
        type: "error",
        data: { callbackId, error: "Signature verification failed" }
      }));
      return;
    }
    
    let validator = await prismaClient.validator.findFirst({
      where: { publicKey },
    });
    
    if (validator) {
      validator = await prismaClient.validator.update({
        where: { id: validator.id },
        data: {
          ip,
          lastSeen: new Date(),
          version: version || validator.version,
          capabilities: capabilities || validator.capabilities,
          status: "online",
        },
      });
    } else {
      validator = await prismaClient.validator.create({
        data: {
          ip,
          publicKey,
          version: version || "1.0.0",
          capabilities: capabilities || ["http"],
          location: "unknown",
          status: "online",
          lastSeen: new Date(),
        },
      });
    }
    
    ws.send(JSON.stringify({
      type: "signup",
      data: {
        validatorId: validator.id,
        callbackId,
      },
    }));
    
    ws.data.validatorId = validator.id;
    ws.data.publicKey = publicKey;
    
    availableValidators.push({
      validatorId: validator.id,
      socket: ws,
      publicKey,
      capabilities: capabilities || ["http"],
      lastActivity: Date.now(),
    });
    
    console.log(`Validator ${validator.id} registered successfully`);
  } catch (error) {
    console.error("Error in signup handler:", error);
    ws.send(JSON.stringify({
      type: "error",
      data: { callbackId, error: "Internal server error" }
    }));
  }
}

async function handleValidationResult(data) {
  if (data.type !== "validate") return;
  
  const callbackId = data.data.callbackId;
  const callback = CALLBACKS[callbackId];
  
  if (callback) {
    await callback(data);
    delete CALLBACKS[callbackId];
  } else {
    console.warn(`No callback found for validation ID: ${callbackId}`);
  }
}

function handleHeartbeat(ws, data) {
  if (!ws.data || !ws.data.validatorId) return;
  
  if (Math.random() < 0.1) { 
    ws.send(JSON.stringify({ type: "ping" }));
  }
}
function handleShutdown(ws, data) {
  if (!ws.data || !ws.data.validatorId) return;
  
  console.log(`Validator ${ws.data.validatorId} is shutting down: ${data.reason || 'unknown reason'}`);
  prismaClient.validator.update({
    where: { id: ws.data.validatorId },
    data: { status: "offline", lastSeen: new Date() }
  }).catch(err => {
    console.error(`Error updating validator status for shutdown:`, err);
  });
  const index = availableValidators.findIndex(v => v.validatorId === ws.data.validatorId);
  if (index !== -1) {
    availableValidators.splice(index, 1);
  }
}



async function verifyMessage(message, publicKeyStr, signature) {
  try {
    const messageBytes = nacl_util.decodeUTF8(message);
    const signatureBytes = new Uint8Array(JSON.parse(signature));
    const publicKeyBytes = new PublicKey(publicKeyStr).toBytes();
    
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (error) {
    console.error("Error verifying message:", error);
    return false;
  }
}



async function sendPayment(validatorPublicKey, amount) {
  if (!connection || !payoutKeypair) {
    console.log(`Would send ${amount} tokens to ${validatorPublicKey} (payout wallet not configured)`);
    return { success: false, reason: "payout_wallet_not_configured" };
  }
  
  try {
    const lamports = Math.floor(amount / COST_PER_VALIDATION * 1000000); // Convert token amount to lamports
    
    if (lamports <= 0) {
      return { success: false, reason: "amount_too_small" };
    }
    
    const receiverPublicKey = new PublicKey(validatorPublicKey);
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payoutKeypair.publicKey,
        toPubkey: receiverPublicKey,
        lamports,
      })
    );
    
    const signature = await connection.sendTransaction(transaction, [payoutKeypair]);
    await connection.confirmTransaction(signature, "confirmed");
    
    console.log(`Payment sent! ${amount / COST_PER_VALIDATION} SOL to ${validatorPublicKey}`);
    console.log(`Transaction: ${signature}`);
    
    return { success: true, signature, amount: lamports };
  } catch (error) {
    console.error("Error sending payment:", error);
    return { success: false, reason: "transaction_failed", error: error.message };
  }
}

function monitorValidators() {
  setInterval(() => {
    const now = Date.now();
    const deadValidators = [];
    
    for (let i = 0; i < availableValidators.length; i++) {
      const validator = availableValidators[i];
      const lastActivity = validator.socket.data?.lastActivity || 0;
      
      if (now - lastActivity > HEARTBEAT_TIMEOUT) {
        deadValidators.push(validator.validatorId);
        
        prismaClient.validator.update({
          where: { id: validator.validatorId },
          data: { status: "offline", lastSeen: new Date() }
        }).catch(err => {
          console.error(`Error updating validator status:`, err);
        });
      }
    }
    
    if (deadValidators.length > 0) {
      console.log(`Removing ${deadValidators.length} inactive validators`);
      for (const id of deadValidators) {
        const index = availableValidators.findIndex(v => v.validatorId === id);
        if (index !== -1) {
          availableValidators.splice(index, 1);
        }
      }
    }
    
    if (availableValidators.length > 0) {
      const randomIndex = Math.floor(Math.random() * availableValidators.length);
      availableValidators[randomIndex].socket.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000); 
}

function scheduleValidations() {
  setInterval(async () => {
    if (availableValidators.length === 0) {
      console.log("No validators available for validation");
      return;
    }
    
    try {

      const websites = await prismaClient.website.findMany({
        where: { disabled: false },
      });
      
      if (websites.length === 0) {
        console.log("No active websites to validate");
        return;
      }
      
      console.log(`Found ${websites.length} active websites to validate`);
      websites.forEach(site => console.log(`Website ${site.id}: ${site.url}, disabled: ${site.disabled}`));
      console.log(`Scheduling validation for ${websites.length} websites`);
      
      activeWebsites.clear();
      websites.forEach(website => activeWebsites.set(website.id, website));
      
      for (const website of websites) {
        if (website.validationInProgress) continue;
        
        for (const validator of availableValidators) {
          if (!validator.capabilities.includes("http") && 
              !validator.capabilities.includes("https")) {
            continue;
          }
          
          const callbackId = randomUUIDv7();
          
          console.log(`Sending validation request for ${website.url} to validator ${validator.validatorId}`);
          
          validator.socket.send(JSON.stringify({
            type: "validate",
            data: {
              url: website.url,
              callbackId,
              websiteId: website.id,  
            },
          }));
          
          
          CALLBACKS[callbackId] = async (data) => {
            if (data.type !== "validate") return;
            
            const { validatorId, status, latency, signedMessage, details, websiteId } = data.data;
            
            try {
              
              const verified = await verifyMessage(
                `${callbackId}|${websiteId}|${status}|${latency}`,
                validator.publicKey,
                signedMessage
              );
              
              if (!verified) {
                console.warn(`Invalid signature for validation result from ${validatorId}`);
                return;
              }
              
              await prismaClient.$transaction(async (tx) => {
                const tick = await tx.websiteTick.create({
                  data: {
                    websiteId: website.id,
                    validatorId: validatorId,
                    status: status,
                    latency: latency,
                    details: details || {},
                    createdAt: new Date(),
                  },
                });
                
                await tx.validator.update({
                  where: { id: validatorId },
                  data: { 
                    pendingPayouts: { increment: COST_PER_VALIDATION },
                    totalValidations: { increment: 1 },
                    totalEarnings: { increment: COST_PER_VALIDATION } // Track total earnings regardless of payout status
                  },
                });
                
                await tx.website.update({
                  where: { id: website.id },
                  data: { 
                    lastChecked: new Date(),
                    status: status,
                    validationInProgress: false
                  },
                });
              });
              
              console.log(`Validation result for ${website.url}: ${status}, latency: ${latency}ms`);
              
              const rewardAmount = COST_PER_VALIDATION;
              validator.socket.send(JSON.stringify({
                type: "reward",
                data: {
                  amount: rewardAmount,
                  websiteId: website.id,
                  status: "pending", 
                },
              }));
              
            } catch (error) {
              console.error(`Error processing validation result:`, error);
              
              prismaClient.website.update({
                where: { id: website.id },
                data: { validationInProgress: false },
              }).catch(console.error);
            }
          };
          
          await prismaClient.website.update({
            where: { id: website.id },
            data: { validationInProgress: true },
          });
          
          break;
        }
      }
    } catch (error) {
      console.error("Error scheduling validations:", error);
    }
  }, VALIDATION_INTERVAL);
}

function schedulePayouts() {
  setInterval(async () => {
    try {
      const validators = await prismaClient.validator.findMany({
        where: {
          pendingPayouts: { gt: 0 },
          status: "online"
        },
      });
      
      if (validators.length === 0) return;
      console.log(`Processing payouts for ${validators.length} validators`);
      for (const validator of validators) {
        console.log(`Processing payout of ${validator.pendingPayouts} tokens to ${validator.id}`);
        const paymentResult = await sendPayment(validator.publicKey, validator.pendingPayouts);
        if (paymentResult.success) {
          await prismaClient.validator.update({
            where: { id: validator.id },
            data: {
              pendingPayouts: 0,
              totalPaid: { increment: validator.pendingPayouts },
              lastPaid: new Date(),
            },
          });
          
          await prismaClient.payment.create({
            data: {
              validatorId: validator.id,
              amount: validator.pendingPayouts,
              txSignature: paymentResult.signature,
              status: "completed",
            },
          });
          
          const validatorObj = availableValidators.find(v => v.validatorId === validator.id);
          if (validatorObj) {
            validatorObj.socket.send(JSON.stringify({
              type: "reward",
              data: {
                amount: validator.pendingPayouts,
                txSignature: paymentResult.signature,
                status: "completed",
              },
            }));
          }
        } else {
          console.warn(`Payment failed for validator ${validator.id}: ${paymentResult.reason}`);
          
          
          await prismaClient.payment.create({
            data: {
              validatorId: validator.id,
              amount: validator.pendingPayouts,
              status: "failed",
              notes: paymentResult.reason,
            },
          });
        }
      }
    } catch (error) {
      console.error("Error processing payouts:", error);
    }
  }, PAYOUT_INTERVAL);
}


async function initialize() {
  console.log("Initializing DePIN Hub...");
  
  await initializeSolana();
  monitorValidators();
  scheduleValidations();
  schedulePayouts();
  
  console.log("DePIN Hub initialized and ready");
}


initialize().catch(error => {
  console.error("Failed to initialize hub:", error);
  process.exit(1);
});