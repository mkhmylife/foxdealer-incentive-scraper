FROM node:14-alpine

WORKDIR /app
CMD yarn start

ADD package.json yarn.lock /app/
RUN yarn install

ADD ./ /app
