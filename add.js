// Configure Twilio (recommended for international)
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendOTPSMS(phoneNumber, otp) {
  try {
    // Format phone number (ensure E.164 format)
    let formattedNumber = phoneNumber;
    if (!phoneNumber.startsWith('+')) {
      formattedNumber = '+234' + phoneNumber.replace(/^0+/, '');
    }
    
    await twilioClient.messages.create({
      body: `Your FEECENT verification code is: ${otp}. Valid for 10 minutes. DO NOT share this code with anyone.`,
      to: formattedNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    console.log(`SMS sent to ${formattedNumber}`);
  } catch (error) {
    console.error('SMS send error:', error);
    throw error;
  }
}

// For Nigeria only, you can use Africa's Talking instead:
/*
const africastalking = require('africastalking')({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME
});

async function sendOTPSMS(phoneNumber, otp) {
  try {
    const result = await africastalking.SMS.send({
      to: phoneNumber,
      message: `Your FEECENT verification code is: ${otp}. Valid for 10 minutes. DO NOT share this code.`,
      from: process.env.AFRICASTALKING_SENDER_ID
    });
    console.log('SMS sent:', result);
  } catch (error) {
    console.error('SMS error:', error);
    throw error;
  }
}
*/


