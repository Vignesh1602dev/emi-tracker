-- Emergency wipe: run this in Supabase > SQL Editor only if the in-app
-- "Clear data" button cannot reach the server. It deletes every customer,
-- payment, document, category and collection figure for every business.
-- Login accounts are kept, so you can sign in again afterwards.
delete from customer_docs;
delete from payments;
delete from customers;
delete from settings;
