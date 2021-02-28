#!/bin/bash
docker build -t mokkahei24/incentive-scraper . && \
docker push mokkahei24/incentive-scraper && \
kubectl -n gds get pod && \
kubectl -n gds patch deployment incentive-scraper -p "{\"spec\":{\"template\":{\"metadata\":{\"labels\":{\"date\":\"`date +'%s'`\"}}}}}"
