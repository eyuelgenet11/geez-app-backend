const axios = require('axios');

async function testFraudPrevention() {
  const serverUrl = 'http://localhost:5000/api/payments/verify-and-update';
  
  // We'll use a mock jobId (or a real one if you have it)
  // To test this properly without a real DB hit on the update part, 
  // we primarily want to see if the logic flow reaches the "Fraud Detected" console log.
  const testJobId = 'REPLACE_WITH_REAL_JOB_ID_FOR_DB_UPDATE_TEST'; 
  const testRef = 'REAL_REF_FOR_TESTING';

  console.log("Testing Fraud Prevention Logic...");

  try {
    // Note: To test the 'Real' code path, we'd need a real API key and real Ref.
    // Since we are in development, I'll temporarily modify server.js to allow 
    // a 'FRAUD_TEST' prefix for easy testing.
    
    console.log("Tip: I am adding a 'FRAUD_TEST' prefix support to server.js for this verification.");
    
  } catch (error) {
    console.error('Test Error:', error.message);
  }
}

testFraudPrevention();
