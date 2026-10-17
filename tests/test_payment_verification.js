const axios = require('axios');

async function testVerification() {
  const serverUrl = 'http://localhost:3000/api/payments/verify-and-update';
  
  // Replace with a real jobId from your Supabase 'jobs' table for a true test
  const testJobId = 'REPLACE_WITH_REAL_JOB_ID'; 
  const testRef = 'TEST_123456'; // References starting with 'TEST' trigger mock success

  console.log(`Testing verification for Job: ${testJobId} with Ref: ${testRef}...`);

  try {
    const response = await axios.post(serverUrl, {
      jobId: testJobId,
      transactionRef: testRef
    });

    console.log('SUCCESS:', response.data);
  } catch (error) {
    if (error.response) {
      console.error('FAILED (API Error):', error.response.data);
    } else {
      console.error('FAILED (Network/Other):', error.message);
    }
    console.log('\nNOTE: This test will fail if the server is not running or if REPLACE_WITH_REAL_JOB_ID is not a valid UUID in your Supabase DB.');
  }
}

testVerification();
