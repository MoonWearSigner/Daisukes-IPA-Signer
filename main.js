const express = require('express');
const cors = require('cors'); // Add this line
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const router = express.Router();
const moment = require('moment-timezone');
const MongoClient = require('mongodb').MongoClient;
const { sign, verify } = require('jsonwebtoken');
const argon2 = require('argon2');
const axios = require('axios');
const CookieP = require('cookie-parser');
const userAgent = require('express-useragent');
const crypto = require('crypto');
const { makeKey, execAwait, makePlist, deleteFiles } = require('./utils');
require('dotenv').config();

const app = express();

// Add this block to configure CORS
const allowedOrigins = ['http://127.0.0.1:8081', 'https://ipasign.pro'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow cookies and authentication headers
}));

app.use(CookieP());
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
}));
app.use(userAgent.express());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets/', express.static(__dirname + '/assets'));
app.use('/apps/', express.static(__dirname + '/files/signed'));
app.use('/plists/', express.static(__dirname + '/files/plists'));
app.use(express.json({ limit: '5GB' }));
app.use(express.urlencoded({ extended: true, limit: '5GB', parameterLimit: 1000000 }));
app.set("views", path.join(__dirname, "views"));
app.set('view engine', 'ejs');
app.disable('x-powered-by');
app.use('/', router);

const port = process.env.PORT || 8080;
const mongourl = process.env.MongoURL || "mongodb://localhost:27017";
const jwttoken = process.env.JWTToken || "askuasign";
const domain = process.env.Domain || "https://ipasign.pro";

const client = new MongoClient(mongourl);

async function storeCert(req, res, uuid) {
    await client.connect();
    const DB = client.db('AskuaSign');
    const DUsers = DB.collection('Stored');

    const token = await argon2.hash(crypto.randomBytes(6).toString('hex'), { hashLength: 18 });
    await DUsers.insertOne({ uuid: uuid, token: token, expire: moment().add(1, 'days').unix() });

    res.cookie('token', token, { maxAge: 31536000 });    
}

async function signApp(uuid, res, req, store) {
    await client.connect();
    const DB = client.db('AskuaSign');
    const Apps = await DB.collection('Apps');
    const DUsers = await DB.collection('Stored');

    let token = req?.cookies?.token;
    let passwordtoken = req?.cookies?.nya;

    var signedtoken = verify(passwordtoken, jwttoken);

    let ouuid;

    if(token) {
        var User = await DUsers.findOne({ token: token });
        if(User) {
            ouuid = User.uuid;
            await DUsers.updateOne({ token: token }, { $set: { expire: moment().add(1, 'days').unix() } });
        }
    }

    if(token && store == "false") {
        res.clearCookie('token');
    }
    res.clearCookie('nya');
    
    const app = await Apps.findOne({ UUID: uuid });

    const appname = app.CustomName;
    const bid = app.BundleID;
    const prov = app.DeleteProv;

    const password = signedtoken.password;
    
    const appPath = path.join(__dirname, 'files', 'temp', `${uuid}.ipa`);
    const p12Path = path.join(__dirname, 'files', 'certs', `${ouuid ? ouuid : uuid}.p12`);
    const provPath = path.join(__dirname, 'files', 'certs', `${ouuid ? ouuid : uuid}.mobileprovision`);
    const plistPath = path.join(__dirname, 'files', 'plists', `${uuid}.plist`);
    const signAppPath = path.join(__dirname, 'files', 'signed', `${uuid}.ipa`);

    var nya = await execAwait(`zsign -k ${p12Path} -m ${provPath} ${password ? `-p ${password}` : ""} ${appPath} -o ${signAppPath} ${bid ? `-b ${bid.replace(/\s+/g, ' ').trim()}` : ""} ${appname ? `-n '${appname}'` : ""} -f ${prov ? '-x' : ''}`);

    if(nya == true) {
        return res.json({ status: 'error', message: "error while signing app (incorrect password)" });
    }
    
    const plist = await makePlist(bid, uuid, nya, domain);
    await fs.writeFileSync(plistPath, plist);
}

async function signApp2(uuid, res, req, store) {
    // Connect to the database
    await client.connect();
    const DB = client.db('AskuaSign');
    const Apps = await DB.collection('Apps');

    // Find the app based on the UUID
    const app = await Apps.findOne({ UUID: uuid });
    if (!app) {
        return res.json({ status: 'error', message: "App not found" });
    }

    // Get necessary app details
    const appname = app.CustomName;
    const bid = app.BundleID;
    const prov = app.DeleteProv;

    // Define paths for signing
    const appPath = path.join(__dirname, 'files', 'temp', `${uuid}.ipa`);
    const p12Path = path.join(__dirname, 'files', 'certs', `${uuid}.p12`);
    const provPath = path.join(__dirname, 'files', 'certs', `${uuid}.mobileprovision`);
    const plistPath = path.join(__dirname, 'files', 'plists', `${uuid}.plist`);
    const signAppPath = path.join(__dirname, 'files', 'signed', `${uuid}.ipa`);

    // Execute the signing process using zsign
    var nya = await execAwait(`zsign -k ${p12Path} -m ${provPath} -o ${signAppPath} ${bid ? `-b ${bid.replace(/\s+/g, ' ').trim()}` : ""} ${appname ? `-n '${appname}'` : ""} -f ${prov ? '-x' : ''}`);

    // Check if the signing process failed
    if(nya == true) {
        return res.json({ status: 'error', message: "Error while signing app (signing failed)" });
    }

    // Create the plist file for installation
    const plist = await makePlist(bid, uuid, nya, domain);
    await fs.writeFileSync(plistPath, plist);

    // Respond with success if everything worked
    return res.json({ status: 'ok', message: "App signed successfully" });
}

async function uploadApp(app, p12, prov, bname, bid, uuid, store, req, res, removeprov)
{
    const appPath = path.join(__dirname, 'files', 'temp', `${uuid}.ipa`);
    const p12Path = path.join(__dirname, 'files', 'certs', `${uuid}.p12`);
    const provPath = path.join(__dirname, 'files', 'certs', `${uuid}.mobileprovision`);

    var AppStruct = {
        UUID: uuid,
        CustomName: bname,
        Name: `${uuid}.ipa`,
        BundleID: bid,
        DeleteProv: removeprov,
        Expire: moment().add(1, 'days').unix()
    }

    await client.connect();
    const DB = client.db('AskuaSign');
    const Apps = await DB.collection('Apps');
    const DUsers = await DB.collection('Stored');
  
    if(typeof p12 === "object") {
        await p12.mv(p12Path);
    } else if(typeof p12 === "string") {
        var data = await axios.get(p12, { responseType: 'arraybuffer' });
        await fs.writeFileSync(p12Path, data.data);
    }

    if(typeof prov === "object") {
        await prov.mv(provPath);
    } else if(typeof prov === "string") {
        var data = await axios.get(prov, { responseType: 'arraybuffer' });
        await fs.writeFileSync(provPath, data.data);
    }

    if(typeof app === "object") {
        await app.mv(appPath);
    } else if(typeof app === "string") {
        var data = await axios.get(app, { responseType: 'arraybuffer' });
        await fs.writeFileSync(appPath, data.data);
    }

    var cookie = req?.cookies?.token;
    if(store == "true") {
        if(cookie) {
            var meow = await DUsers.findOne({ token: cookie });
            if(meow) {
                await Apps.insertOne(AppStruct);
                return;
            } else {
                res.clearCookie('token');
            }
        } else {
            await storeCert(req, res, uuid);
        }
    } else if(store == "false" && cookie) {
        var meow = await DUsers.findOne({ token: cookie });
        if(meow) {
            await Apps.insertOne(AppStruct);
            return;
        }
    }

    await Apps.insertOne(AppStruct);
}

router.get('/', async (req, res) => {
    var mobile = req.useragent.isMobile;
    var token = req?.cookies?.token;

    return res.render('index.ejs', { mobile: mobile, token: token });
});

router.get('/notice', async (req, res) => {
    return res.render('notice.ejs');
});

router.post('/upload', async (req, res) => {
    var app = req?.files?.ipa;
    if (!app && !req.body?.ipa) {
        res.json({ status: 'error', message: "Missing parameters (IPA)" });
        return;
    }
    app = app ? app : req.body?.ipa;
    
    const p12 = req?.files?.p12;
    if (!p12 && !req.body?.p12) {
        res.json({ status: 'error', message: "Missing parameters (P12)" });
        return;
    }

    const prov = req?.files?.prov;
    if (!prov && !req.body?.prov) {
        res.json({ status: 'error', message: "Missing parameters (PROV)" });
        return;
    }

    const { password, bname, bid, store, removeprov } = req.body;

    const missingParams = ['ipa', 'p12', 'prov']
        .filter(param => !req.body[param] && !req.files[param]);

    if (missingParams.length) {
        res.json({ status: 'error', message: `Missing parameters: ${missingParams.join(', ')}` });
        return;
    }

    try {
        const uuid = makeKey(6);
        const nya = sign({ password: password }, jwttoken, { expiresIn: '300s' });

        res.cookie('nya', nya, { maxAge: 31536000 });

        await uploadApp(app, p12, prov, bname, bid, uuid, store, req, res, removeprov);

        res.json({ status: 'ok', message: "Uploaded!", uuid: uuid });
    } catch (error) {
        console.log(error)
        return res.json({ status: 'error', message: "error while uploading app" });
    }
});

router.get('/sign', async (req, res) => {
    const { uuid, store } = req.query;
    if (!uuid) {
        res.json({ status: 'error', message: "Missing parameters" });
        return;
    }
    try {
        await signApp(uuid, res, req, store);

        res.json({ status: 'ok', message: "Signed!", url: `itms-services://?action=download-manifest&url=${domain}/plists/${uuid}.plist`, pcurl: `${domain}/install?uuid=${uuid}` });

        let token = req?.cookies?.token;
        await client.connect();
        const DB = await client.db('AskuaSign');
        const DUsers = await DB.collection('Stored');

        if(token) {
            var User = await DUsers.findOne({ token: token });
            if(User) {
                return;
            }
        }
        return deleteFiles(uuid);
    } catch (error) {
        console.log(error)
        return res.json({ status: 'error', message: "error while signing app (unknown, report in discord)" });
    }
});

router.get('/sign2', async (req, res) => {
    const { uuid, store } = req.query;
    
    // Check for the UUID parameter
    if (!uuid) {
        res.json({ status: 'error', message: "Missing parameters" });
        return;
    }

    try {
        // Sign the app using the UUID
        await signApp2(uuid, res, req, store);

        // Respond with success and provide the URLs for downloading the signed IPA
        res.json({
            status: 'ok',
            message: "Signed!",
            url: `itms-services://?action=download-manifest&url=${domain}/plists/${uuid}.plist`,
            pcurl: `${domain}/install?uuid=${uuid}`
        });

        // Optionally delete the files after signing
        return deleteFiles(uuid);
    } catch (error) {
        // Handle any errors that occur during the signing process
        console.log(error);
        return res.json({ status: 'error', message: "Error while signing app (unknown, report in Discord)" });
    }
});

router.get('/install', async (req, res) => {
    var uuid = req?.query?.uuid;
    if (!uuid) {
        res.json({ status: 'error', message: "Missing parameters" });
        return;
    }
    res.redirect(`itms-services://?action=download-manifest&url=${domain}/plists/${uuid}.plist`);
});


setInterval(async () => {
    await client.connect();
    const DB = client.db('AskuaSign');
    const Apps = await DB.collection('Apps');
    const Stored = await DB.collection('Stored');
    const SignedApps = await Apps.find({ Expire: { $lt: moment().unix() } }).toArray();
    const StoredCerts = await Stored.find({ expire: { $lt: moment().unix() } }).toArray();

    SignedApps.forEach(async (app) => {
        const uuid = app.UUID;
        try
        {
            if(app.Expire < moment().unix()) {
                await Apps.deleteOne({ UUID: uuid });
                await fs.unlinkSync(path.join(__dirname, 'files', 'plists', `${uuid}.plist`));
                await fs.unlinkSync(path.join(__dirname, 'files', 'signed', `${uuid}.ipa`));
            }
        } catch (_) {
            null
        }
     })
     StoredCerts.forEach(async (cert) => {
        const uuid = cert.uuid;
        try
        {
            if(cert.expire < moment().unix()) {
                await Stored.deleteOne({ uuid: uuid }); // Corrected from StoredCerts.deleteOne to Stored.deleteOne
                await fs.unlinkSync(path.join(__dirname, 'files', 'certs', `${uuid}.p12`));
                await fs.unlinkSync(path.join(__dirname, 'files', 'certs', `${uuid}.mobileprovision`));
            }
        } catch (_) {
            null
        }
     })

}, 5 * 1000);

// -------------------- Global Error Handlers --------------------

// 1. Handle Uncaught Exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optional: Add logic to log the error to an external service or perform cleanup
});

// 2. Handle Unhandled Promise Rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optional: Add logic to log the reason to an external service or perform cleanup
});

// 3. Express Error-Handling Middleware
app.use((err, req, res, next) => {
    console.error('Express Error:', err);
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
});

// -------------------- End of Global Error Handlers --------------------

// Start the server
app.listen(port, () => {
    console.log(`AskuaSign listening at 0.0.0.0:${port}`);
});
