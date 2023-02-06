const express = require('express'); // Express web server framework
const AWS = require('aws-sdk'); // AWS SDK
const admin = require('firebase-admin'); // Firebase Admin SDK
const serviceAccount = require('./serviceAccount.json'); // service account key
const BodyParser = require('body-parser'); // for parsing JSON
const uuid = require('uuid'); // for generating unique file names
const dotenv = require('dotenv'); // for loading environment variables
const multer = require('multer'); // for parsing multipart/form-data

const storage = multer.memoryStorage(); // memory storage
const upload = multer({ storage }); // multer instance

// configure Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount), // service account key
}); // initialize Firebase Admin SDK
const db = admin.firestore(); // get Firestore instance
admin.firestore().settings({ignoreUndefinedProperties:true}); // ignore undefined properties

const app = express(); // create express app
// configure express app
app.use(BodyParser.json({
    limit: '50mb',
})); // parse JSON
app.use(BodyParser.urlencoded({
    limit: '50mb',
    extended: false,
})); // parse URL-encoded bodies

const PORT = process.env.PORT || 4200; // port to listen on
app.listen(PORT, () => console.log(`Listening on port ${PORT}`)); // start server

dotenv.config(); // load environment variables

// configure AWS SDK
AWS.config.update({
    region: process.env.AWS_REGION, // region of your bucket
}); // update AWS config

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, // access key
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // secret access key
    region: process.env.AWS_REGION, // region of your bucket
    signatureVersion: 'v4', // signature version
}); // create S3 instance

const textract = new AWS.Textract({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, // access key
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // secret access key
    region: process.env.AWS_REGION, // region of your bucket
    signatureVersion: 'v4', // signature version
}); // create Textract instance

const inventoryUpload = async (req, res) => {
    try {
        const uuidGenerator = uuid.v4(); // generate unique file name
        const contentType = req.file.mimetype; // get content type
        const extension = contentType.split('/')[1]; // get file extension
        const fileName = `${uuidGenerator}.${extension}`; // generate unique file name
        const fileData = req.file.buffer; // get file data
        
        const s3Params = {
            Bucket: process.env.S3_BUCKET_NAME, // bucket name
            Key: fileName, // file name
            Body: fileData, // file content
            ContentEncoding: 'base64', // content encoding
            ContentType: contentType, // content type
        }; // params for S3 upload

        s3.upload(s3Params, async (err, data) => {
            if (err) {
                console.error("Error uploading to S3: ", err); // log error
            } else {
                const s3ObjectParams = {
                    Bucket: process.env.S3_BUCKET_NAME, // bucket name
                    Key: fileName, // file name
                }; // params for S3 object
        
                s3.getObject(s3ObjectParams, (err, data) => {
                    if (err) {
                        console.error("Error getting object from S3: ", err); // log error
                    } else {
                        const textractParams = {
                            Document: {
                                Bytes: data.Body, // S3 object content
                            }
                        }; // params for Textract
        
                        textract.analyzeExpense(textractParams, (err, jdata) => {
                            if (err) {
                                console.error("Error analysing expense: ", err); // log error
                            } else {
                                var summaryFields = {
                                    "invoice_id": "N/A",
                                    "invoice_date": "N/A",
                                    "vendor_name": "N/A",
                                    "vendor_phone": "N/A",
                                    "total": 0,
                                }; // array of summary fields
                                var lineItems = []; // array of line items
                                jdata.ExpenseDocuments.forEach((expenseDocument) => {
                                    expenseDocument.SummaryFields.forEach((summaryField) => {
                                        if (summaryField.Type.Text == "VENDOR_NAME" && summaryFields["vendor_name"] == "N/A"){
                                            summaryFields["vendor_name"] = summaryField.ValueDetection.Text.replace(/\n/g, ' '); // value of field
                                        } else if (summaryField.Type.Text == "TOTAL" && summaryFields["total"] == 0){
                                            summaryFields["total"] = summaryField.ValueDetection.Text.replace(/\n/g, ' '); // value of field
                                        } else if (summaryField.Type.Text == "INVOICE_RECEIPT_DATE" && summaryFields["invoice_date"] == "N/A"){
                                            summaryFields["invoice_date"] = summaryField.ValueDetection.Text.replace(/\n/g, ' '); // value of field
                                        } else if (summaryField.Type.Text == "INVOICE_RECEIPT_ID" && summaryFields["invoice_id"] == "N/A"){
                                            summaryFields["invoice_id"] = summaryField.ValueDetection.Text.replace(/\n/g, ' '); // value of field
                                        } else if (summaryField.Type.Text == "VENDOR_PHONE" && summaryFields["vendor_phone"] == "N/A"){
                                            summaryFields["vendor_phone"] = summaryField.ValueDetection.Text.replace(/\n/g, ' '); // value of field
                                        }
                                    }); // summary fields
                                    // Important Note: VENDOR_NAME and TOTAL are the needed fields
                                    
                                    expenseDocument.LineItemGroups.forEach((lineItemGroup) => {
                                        lineItemGroup.LineItems.forEach((lineItem) => {
                                            var lineItemMap = {}; // map of line item
                                            lineItem.LineItemExpenseFields.forEach((lineItemExpenseField) => {
                                                if (lineItemExpenseField.Type.Text == "ITEM") {
                                                    lineItemMap["item"] = lineItemExpenseField.ValueDetection.Text.replace(/\n/g, ' '); // name of item
                                                } else if (lineItemExpenseField.Type.Text == "PRICE") {
                                                    lineItemMap["price"] = lineItemExpenseField.ValueDetection.Text; // price of item
                                                } else if (lineItemExpenseField.Type.Text == "QUANTITY") {
                                                    lineItemMap["quantity"] = lineItemExpenseField.ValueDetection.Text; // quantity of item
                                                }
                                            }); // line item expense fields
                                            lineItems.push(lineItemMap); // push line item to array
                                        }); // line items
                                    }); // line item groups
                                    // Important Note: Every Line Item has Name, Quantity and Price as keys 
                                }); // expense documents

                                console.log(JSON.stringify(summaryFields)); // log summary fields
                                console.log(JSON.stringify(lineItems)); // log line items

                                try {
                                    db.collection('bills').doc(uuidGenerator).set({
                                        invoice_id: summaryFields.invoice_id,
                                        vendor_name: summaryFields.vendor_name,
                                        vendor_phone: summaryFields.vendor_phone,
                                        invoice_date: summaryFields.invoice_date,
                                        items: lineItems,
                                        total: summaryFields.total,
                                        date: new Date().toISOString(),
                                    }).then((docRef) => {
                                        console.log("Document written with ID: ", docRef.id); // log success
                                    }).catch((error) => {
                                        console.error("Error adding document: ", error); // log error
                                    }); // add bill to database

                                    const number = parseFloat(summaryFields.total.match(/[+-]?\d+(\.\d+)?/g)[0]);
                                    const num = (Math.round(number * 100) / 100).toFixed(2);

				                    db.collection('data').doc('stats').update({
					                    totalAmount: admin.firestore.FieldValue.increment(num), // increment discount
                                    }).then((docRef) => {
                                        console.log("Document written with ID: ", docRef.id); // log success
                                    }).catch((error) => {
                                        console.error("Error adding document: ", error); // log error
                                    }); // update totalAmount

                                    db.collection('data').doc('stats').update({
                                        totalBills: admin.firestore.FieldValue.increment(1), // increment discount
                                    }).then((docRef) => {
                                        console.log("Document written with ID: ", docRef.id); // log success
                                    }).catch((error) => {
                                        console.error("Error adding document: ", error); // log error
                                    }); // update totalBills

                                } catch (err){
                                    throw("Error uploading to the firestore: " , err);
                                }
                                 // add to firestore
                                res.status(200).redirect("https://monke-inventory.web.app/bills.html"); // send success
                            }
                        }); // analyse expense
                    }
                }); // get object from S3
            }
        }); // upload to S3

    } catch (error) {
        console.error("Error connecting to S3: ", error); // log error
        throw error;
    }
} // inventoryUpload

app.post('/inventoryUpload', upload.single('bill'), (req, res) => {
    return inventoryUpload(req, res);
}); // POST /inventoryUpload

// pm2 --name monke start npm -- start
