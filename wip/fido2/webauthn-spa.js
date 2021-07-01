const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const fido2 = require('@simplewebauthn/server')
const base64url = require('base64url')

router.use(express.json())

const RP_ID = () => {
  // console.log('process.env.HOSTNAME', process.env.HOSTNAME)
  // return process.env.HOSTNAME
  return 'nip.io'
}
const RP_NAME = 'WebAuthn Simple'
const TIMEOUT = 30 * 1000 * 60
let users = []

// helper functions
const userFind = (id) => {
  // return db.get('users').find({ username: id }).value()
  return users.find(user => user.username === id)
}

const userCreate = (user) => {
  //db.get('users').push(user).write()
  users.push(user)
}

const userUpdate = (id, _user) => {
  let user = userFind(id)
  if (user) {
    // db.get('users').find({ username: id }).assign(_user).write()
    user = Object.assign(user, _user)
  }
}

const userDelete = (id) => { }

const authCheck = (req, res, next) => {
  if (req.header('X-Requested-With') !== 'XMLHttpRequest') return res.status(400).json({ error: 'invalid access.' })
  // console.log('req.headers', req.headers)
  if (!req.headers.authorization) return res.status(400).json({ error: 'invalid access 2.' })
  const username = req.headers.authorization
  req.token = {
    username
  }
  next()
};

const getOrigin = (userAgent) => {
  let origin = '';
  if (userAgent.indexOf('okhttp') === 0) {
    const octArray = process.env.ANDROID_SHA256HASH.split(':').map((h) => parseInt(h, 16),)
    const androidHash = base64url.encode(octArray)
    origin = `android:apk-key-hash:${androidHash}`
  } else {
    origin = process.env.ORIGIN
  }
  return origin
}

router.post('/spa-register', (req, res) => {
  try {
    const { username, password } = req.body
    // Only check username, no need to check password as this is a mock
    if (!username || !/[a-zA-Z0-9-_]+/.test(username)|| !password) return res.status(400).json({ error: 'Bad request' })

    // See if account already exists
    let user = userFind(username)
    // If user entry is not created yet, create one
    if (!user) {
      user = {
        username,
        password,
        id: base64url.encode(crypto.randomBytes(32)),
        credentials: [],
      }
      userCreate(user)
    }
    res.json(user)
  } catch (e) {
    res.status(500).json({ error: e.toString() })
  }
})

// Verifies user credential and let the user sign-in.
// No preceding registration required.
// This only checks if `username` is not empty string and ignores the password.
router.post('/spa-login', (req, res) => {
  try {
    const { username, password } = req.body
    const user = userFind(username)
    if (!user) return res.status(401).json({ error: 'User not found' })
    if (user.password !== password) return res.status(401).json({ error: 'Login failed' })
    res.json(user)
  } catch (e) {
    res.status(500).json({ error: e.toString() })
  }
})

router.get('/signout', (req, res) => {
  // Remove the session
  // Redirect to `/`
  res.redirect(302, '/')
})

// Returns a credential id
// (This server only stores one key per username.)
// Response format:
// ```{ username: String, credentials: [Credential] }
// ```
// Credential
// ```
// { credId: String, publicKey: String, aaguid: ??, prevCounter: Int };
// ```
router.post('/get-keys', authCheck, (req, res) => {
  const user = userFind(req.token.username)
  res.json(user || {})
})

// Removes a credential id attached to the user
// Responds with empty JSON `{}`
router.post('/remove-key', authCheck, (req, res) => {
  const credId = req.query.credId
  const { username } = req.token
  const user = userFind(username)
  const newCreds = user.credentials.filter((cred) => {
    // Leave credential ids that do not match
    return cred.credId !== credId;
  })
  userUpdate(username, { credentials: newCreds })
  res.json({});
});

/**
 * Respond with required information to call navigator.credential.create()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     rp: {
       id: String,
       name: String
     },
     user: {
       displayName: String,
       id: String,
       name: String
     },
     publicKeyCredParams: [{  // @herrjemand
       type: 'public-key', alg: -7
     }],
     timeout: Number,
     challenge: String,
     excludeCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...],
     authenticatorSelection: {
       authenticatorAttachment: ('platform'|'cross-platform'),
       requireResidentKey: Boolean,
       userVerification: ('required'|'preferred'|'discouraged')
     },
     attestation: ('none'|'indirect'|'direct')
 * }```
 **/
router.post('/spa-register-request', authCheck, async (req, res) => {
  const { username } = req.token
  const user = userFind(username)
  try {
    const excludeCredentials = [];
    if (user.credentials.length > 0) {
      for (let cred of user.credentials) {
        excludeCredentials.push({
          id: cred.credId,
          type: 'public-key',
          transports: ['internal'],
        });
      }
    }
    const pubKeyCredParams = [];
    // const params = [-7, -35, -36, -257, -258, -259, -37, -38, -39, -8];
    const params = [-7, -257];
    for (let param of params) {
      pubKeyCredParams.push({ type: 'public-key', alg: param });
    }
    const as = {}; // authenticatorSelection
    const aa = req.body.authenticatorSelection.authenticatorAttachment;
    const rr = req.body.authenticatorSelection.requireResidentKey;
    const uv = req.body.authenticatorSelection.userVerification;
    const cp = req.body.attestation; // attestationConveyancePreference
    let asFlag = false;
    let authenticatorSelection;
    let attestation = 'none';

    if (aa && (aa == 'platform' || aa == 'cross-platform')) {
      asFlag = true;
      as.authenticatorAttachment = aa;
    }
    if (rr && typeof rr == 'boolean') {
      asFlag = true;
      as.requireResidentKey = rr;
    }
    if (uv && (uv == 'required' || uv == 'preferred' || uv == 'discouraged')) {
      asFlag = true;
      as.userVerification = uv;
    }
    if (asFlag) {
      authenticatorSelection = as;
    }
    if (cp && (cp == 'none' || cp == 'indirect' || cp == 'direct')) {
      attestation = cp;
    }

    const options = fido2.generateAttestationOptions({
      rpName: RP_NAME,
      rpID: RP_ID(),
      userID: user.id,
      userName: user.username,
      timeout: TIMEOUT,
      // Prompt users for additional information about the authenticator.
      attestationType: attestation,
      // Prevent users from re-registering existing authenticators
      excludeCredentials,
      authenticatorSelection,
    });

    // Temporary hack until SimpleWebAuthn supports `pubKeyCredParams`
    options.pubKeyCredParams = [];
    for (let param of params) {
      options.pubKeyCredParams.push({ type: 'public-key', alg: param });
    }

    res.json(options);
  } catch (e) {
    res.status(400).send({ error: e });
  }
});

/**
 * Register user credential.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       attestationObject: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/spa-register-response', authCheck, async (req, res) => {
  console.log('response req.query.challenge', req.query.challenge) // BE
  const username = req.token.username;
  const expectedChallenge = req.query.challenge;
  const expectedOrigin = getOrigin(req.get('User-Agent'));
  const expectedRPID = RP_ID()
  const credId = req.body.id;
  const type = req.body.type;

  try {
    const { body } = req;

    const verification = await fido2.verifyAttestationResponse({
      credential: body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
    });

    const { verified, authenticatorInfo } = verification;

    if (!verified) {
      throw 'User verification failed.';
    }

    const { base64PublicKey, base64CredentialID, counter } = authenticatorInfo;

    const user = userFind(req.token.username)
    const existingCred = user.credentials.find(
      (cred) => cred.credID === base64CredentialID,
    );

    if (!existingCred) {
      /**
       * Add the returned device to the user's list of devices
       */
      user.credentials.push({
        publicKey: base64PublicKey,
        credId: base64CredentialID,
        prevCounter: counter,
      });
    }

    userUpdate(username, user)
    // Respond with user info
    res.json(user);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

/**
 * Respond with required information to call navigator.credential.get()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     challenge: String,
     userVerification: ('required'|'preferred'|'discouraged'),
     allowCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...]
 * }```
 **/
router.post('/spa-signin-request', authCheck, async (req, res) => {
  try {
    const user = userFind(req.token.username)
    if (!user) {
      // Send empty response if user is not registered yet.
      res.json({ error: 'User not found.' });
      return;
    }

    const credId = req.query.credId;
    const userVerification = req.body.userVerification || 'required';
    const allowCredentials = [];
    for (let cred of user.credentials) {
      // `credId` is specified and matches
      if (credId && cred.credId == credId) {
        allowCredentials.push({
          id: cred.credId,
          type: 'public-key',
          transports: ['internal']
        });
      }
    }

    const options = fido2.generateAssertionOptions({
      timeout: TIMEOUT,
      rpID: RP_ID(),
      allowCredentials,
      /**
       * This optional value controls whether or not the authenticator needs be able to uniquely
       * identify the user interacting with it (via built-in PIN pad, fingerprint scanner, etc...)
       */
      userVerification,
    });

    res.json(options);
  } catch (e) {
    res.status(400).json({ error: e });
  }
});

/**
 * Authenticate the user.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       authenticatorData: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/spa-signin-response', authCheck, async (req, res) => {
  const { body } = req;
  const expectedChallenge = req.query.challenge;
  const expectedOrigin = getOrigin(req.get('User-Agent'));
  const expectedRPID = RP_ID()

  // Query the user
  const user = userFind(req.token.username)

  let credential = user.credentials.find((cred) => cred.credId === req.body.id);

  try {
    if (!credential) {
      throw 'Authenticating credential not found.';
    }

    const verification = fido2.verifyAssertionResponse({
      credential: body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      authenticator: credential,
    });

    const { verified, authenticatorInfo } = verification;

    if (!verified) {
      throw 'User verification failed.';
    }

    credential.prevCounter = authenticatorInfo.counter;

    userUpdate(req.token.username, user)

    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e });
  }
});

module.exports = router;