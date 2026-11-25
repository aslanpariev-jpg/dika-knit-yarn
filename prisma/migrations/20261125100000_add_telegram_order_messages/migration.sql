CREATE TABLE "TelegramOrderMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramOrderMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TelegramOrderMessage_orderId_idx" ON "TelegramOrderMessage"("orderId");

ALTER TABLE "TelegramOrderMessage"
ADD CONSTRAINT "TelegramOrderMessage_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
