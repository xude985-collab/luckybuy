export function paymentMethods(){
  return {stripe:!!(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET),paypal:!!(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_SECRET)};
}
